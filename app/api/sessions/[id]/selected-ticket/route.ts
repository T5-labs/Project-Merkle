// Tell Next.js this route is fully dynamic — we read the request body, the
// request headers, and the DB at runtime, never at build time.
export const dynamic = "force-dynamic";

// Pin the Node.js runtime — the `postgres` driver uses Node-only APIs.
export const runtime = "nodejs";

/**
 * REST endpoints under /api/sessions/[id]/selected-ticket:
 *
 *   GET   — return the currently-selected ticket for a support session
 *           (key/project/number) or { key: null } if no selection is set.
 *   PATCH — set or clear the selection. Body: { ticket_key: string | null }.
 *           A non-null key must (a) match the strict format regex and (b)
 *           already exist in the session's pushed options. Both checks happen
 *           in setSelectedSupportTicket; format is validated here for a
 *           cleaner 400 message.
 *
 * Auth: X-Team-ID header (same model as MCP tools).
 * Errors:
 *   401 — missing/invalid X-Team-ID
 *   400 — session is not a support session; or invalid body / bad ticket_key
 *   404 — session not found
 */
import "server-only";

import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { validateMembership } from "@/lib/mcp/auth";
import {
  getSupportSessionState,
  findSupportTicketOption,
  setSelectedSupportTicket,
} from "@/lib/mcp/repos";
import { broadcastSystemMessage } from "@/lib/mcp/broadcast";
import { MCPError } from "@/lib/mcp/errors";

// Same shape as the MCP-tool ticket key regex in vault.ts — kept in sync so
// the REST and MCP boundaries reject identically-malformed input.
const TICKET_KEY_RE = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/;

const patchBodySchema = z
  .object({
    ticket_key: z.union([z.string(), z.null()]),
  })
  .strict();

function extractTeamIdFromRequest(req: NextRequest): string | null {
  return req.headers.get("x-team-id");
}

/**
 * Auth + support-session guard shared by GET and PATCH. Returns either an
 * already-built error response (caller should return it directly) or the
 * validated participant + state for the happy path.
 */
async function authAndSupportGuard(
  req: NextRequest,
  id: string,
): Promise<
  | { ok: true; participant: { teamId: string; teamName: string } }
  | { ok: false; response: Response }
> {
  const teamId = extractTeamIdFromRequest(req);
  const auth = await validateMembership(teamId, id);
  if (!auth.valid) {
    if (auth.reason === "not_found") {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "session not found" },
          { status: 404 },
        ),
      };
    }
    return {
      ok: false,
      response: NextResponse.json(
        { error: "missing or invalid team_id" },
        { status: 401 },
      ),
    };
  }

  const state = await getSupportSessionState(id);
  if (!state) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "session not found" },
        { status: 404 },
      ),
    };
  }
  if (!state.isSupportSession) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "not a support session" },
        { status: 400 },
      ),
    };
  }

  return {
    ok: true,
    participant: {
      teamId: auth.participant.teamId,
      teamName: auth.participant.teamName,
    },
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const guard = await authAndSupportGuard(req, id);
  if (!guard.ok) return guard.response;

  // Re-fetch state — the guard already validated, but doesn't return it.
  // Cheaper than threading the value through; both reads hit the same row.
  const state = await getSupportSessionState(id);
  if (!state) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  if (state.selectedTicketKey === null) {
    return NextResponse.json({ key: null });
  }

  const option = await findSupportTicketOption(id, state.selectedTicketKey);
  if (option === null) {
    // Mirror the MCP-tool behavior: a stored selection that's no longer in
    // the options table reads as null rather than 404 / 500.
    return NextResponse.json({ key: null });
  }

  return NextResponse.json({
    key: option.ticketKey,
    project: option.project,
    number: option.number,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const guard = await authAndSupportGuard(req, id);
  if (!guard.ok) return guard.response;
  const { participant } = guard;

  // Parse the body. Reject anything other than { ticket_key: string | null }.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = patchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "ticket_key must be string or null" },
      { status: 400 },
    );
  }
  const ticketKey = parsed.data.ticket_key;

  // Enforce the strict key format on non-null inputs before calling the
  // repo. setSelectedSupportTicket also validates existence in options, but
  // format-checking here gives a clearer 400.
  if (ticketKey !== null && !TICKET_KEY_RE.test(ticketKey)) {
    return NextResponse.json(
      { error: "ticket_key has invalid format" },
      { status: 400 },
    );
  }

  // Apply the selection. If the key is non-null and not in the option set,
  // the repo throws MCPError('not_found') — convert to 400 for the REST API
  // because the client supplied a key that doesn't exist in this session's
  // options (a client error, not a missing-resource error on the URL).
  let result: { previousKey: string | null; newKey: string | null };
  try {
    result = await setSelectedSupportTicket(id, ticketKey, participant.teamId);
  } catch (err) {
    if (err instanceof MCPError && err.code === "not_found") {
      return NextResponse.json(
        { error: "ticket_key not in this session's pushed options" },
        { status: 400 },
      );
    }
    throw err;
  }

  // Broadcast the selection change to all polling teams. Includes the prior
  // key so listeners can compute a diff without re-fetching.
  await broadcastSystemMessage(id, {
    event: "support_ticket_selected",
    ticket_key: result.newKey,
    previous_ticket_key: result.previousKey,
    changed_by_team_id: participant.teamId,
    changed_by_team_name: participant.teamName,
  });

  return NextResponse.json({ key: result.newKey });
}
