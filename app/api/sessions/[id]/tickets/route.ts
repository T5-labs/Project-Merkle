// Tell Next.js this route is fully dynamic — we read the request headers and
// the DB at runtime, never at build time.
export const dynamic = "force-dynamic";

// Pin the Node.js runtime — the `postgres` driver uses Node-only APIs.
export const runtime = "nodejs";

/**
 * REST endpoint: GET /api/sessions/[id]/tickets
 *
 * Returns the pushed ticket options for a support session. Used by the UI
 * (the dropdown beside "Open Document") so it can render the candidate list
 * without going through the MCP transport.
 *
 * Auth: X-Team-ID header (same model as MCP tools).
 * Errors:
 *   401 — missing/invalid X-Team-ID
 *   400 — session is not a support session
 *   404 — session not found
 */
import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { validateMembership } from "@/lib/mcp/auth";
import {
  getSupportSessionState,
  listSupportTicketOptions,
} from "@/lib/mcp/repos";

/**
 * Extracts the X-Team-ID header from a NextRequest. Returns null if absent.
 * Header names are case-insensitive per RFC 7230 — Next.js's Headers wrapper
 * already normalises lookups, so we read by canonical-case here.
 */
function extractTeamIdFromRequest(req: NextRequest): string | null {
  return req.headers.get("x-team-id");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  // Validate the X-Team-ID header and confirm active membership. We reuse
  // validateMembership directly (rather than requireMembership, which is
  // RequestHandlerExtra-bound) and map the result onto REST error shapes.
  const teamId = extractTeamIdFromRequest(req);
  const auth = await validateMembership(teamId, id);
  if (!auth.valid) {
    if (auth.reason === "not_found") {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "missing or invalid team_id" },
      { status: 401 },
    );
  }

  // Support-session gate. getSupportSessionState returns null when the
  // session doesn't exist, but validateMembership already covers that case —
  // we still guard explicitly to avoid a downstream TypeError.
  const state = await getSupportSessionState(id);
  if (!state) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  if (!state.isSupportSession) {
    return NextResponse.json(
      { error: "not a support session" },
      { status: 400 },
    );
  }

  const options = await listSupportTicketOptions(id);
  return NextResponse.json({
    tickets: options.map((o) => ({
      key: o.ticketKey,
      project: o.project,
      number: o.number,
      pushed_at: o.pushedAt.toISOString(),
    })),
  });
}
