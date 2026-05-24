/**
 * Auth helpers for MCP tool implementations.
 *
 * SERVER-ONLY — this module queries the participants table.
 *
 * The MCP SDK (v1.29.0) exposes the originating HTTP request through the
 * RequestHandlerExtra.requestInfo field (type RequestInfo from the SDK's types.d.ts).
 * requestInfo.headers is typed as IsomorphicHeaders = Record<string, string | string[] | undefined>.
 *
 * Team-id resolution order (v0.12+):
 *   1. `team_id` argument carried inside the tool call's JSON-RPC arguments
 *      (primary path — eliminates the static-header restart requirement for
 *      Claude Code's HTTP-MCP transport).
 *   2. `X-Team-ID` HTTP header (backward-compat fallback for clients that
 *      already configured a static header in `.mcp.json`).
 *
 * Usage inside a tool handler:
 *   server.tool('my_tool', schema, async (args, extra) => {
 *     const participant = await requireMembership(extra, args.session_id, args.team_id);
 *     // participant is fully typed Participant row
 *   });
 */
import "server-only";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { getParticipant, getSessionById } from "@/lib/mcp/repos";
import { MCPError, type ErrorCode } from "@/lib/mcp/errors";
import type { Participant } from "@/db/schema";

// The extra context passed to every tool handler by the SDK.
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// ---------------------------------------------------------------------------
// Team-id extraction
// ---------------------------------------------------------------------------

/**
 * Resolves the caller's team_id from (in priority order) the tool call's
 * `team_id` argument, then the `X-Team-ID` HTTP header. Returns null if
 * neither source provides a value.
 *
 * The args-first path is the v0.12 primary auth source — agents pass team_id
 * in their JSON-RPC arguments so they no longer need to edit `.mcp.json` and
 * restart Claude Code after `join_session`. The header path is preserved as a
 * backward-compat fallback for clients that already configured a static
 * header.
 *
 * The SDK passes the original HTTP request headers via extra.requestInfo.headers
 * (IsomorphicHeaders). Header names from the HTTP layer are lowercased by the
 * SDK's Web Standard transport before being placed into this map.
 */
export function extractTeamId(
  extra: ToolExtra,
  argsTeamId?: string | null,
): string | null {
  // 1. Args-side team_id wins when present (new primary path).
  if (argsTeamId && typeof argsTeamId === "string" && argsTeamId.length > 0) {
    return argsTeamId;
  }

  // 2. Fall back to the X-Team-ID header for legacy header-configured clients.
  const headers = extra.requestInfo?.headers;
  if (!headers) return null;

  const raw = headers["x-team-id"];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

// ---------------------------------------------------------------------------
// Membership validation
// ---------------------------------------------------------------------------

type ValidResult = { valid: true; participant: Participant };
type InvalidResult = {
  valid: false;
  reason: "unauthorized" | "not_found" | "session_closed";
};

/**
 * Validates that a teamId holds an active membership in the given session.
 * Returns { valid: true, participant } on success or { valid: false, reason } on failure.
 */
export async function validateMembership(
  teamId: string | null,
  sessionId: string,
): Promise<ValidResult | InvalidResult> {
  if (!teamId) {
    return { valid: false, reason: "unauthorized" };
  }

  const session = await getSessionById(sessionId);
  if (!session) {
    return { valid: false, reason: "not_found" };
  }

  const participant = await getParticipant(sessionId, teamId);
  if (!participant) {
    return { valid: false, reason: "unauthorized" };
  }

  // Status 'disconnected' teams are soft-removed but may still read.
  // Authorization passes as long as the row exists — tool handlers enforce
  // tighter rules (e.g. write gating when session_closed) separately.
  return { valid: true, participant };
}

// Map validation failure reasons to MCPError codes
const reasonToCode: Record<string, ErrorCode> = {
  unauthorized: "unauthorized",
  not_found: "not_found",
  session_closed: "forbidden",
};

/**
 * Convenience wrapper: extracts the caller's team_id (args first, then header),
 * validates membership, and returns the Participant row on success. Throws
 * MCPError on any failure so tool handlers can call this as a single auth
 * guard.
 *
 * `argsTeamId` is the optional `team_id` field from the tool call's input
 * arguments. Tool handlers should pass `input.team_id` through; when present
 * it supersedes the X-Team-ID header.
 */
export async function requireMembership(
  extra: ToolExtra,
  sessionId: string,
  argsTeamId?: string | null,
): Promise<Participant> {
  const teamId = extractTeamId(extra, argsTeamId);
  const result = await validateMembership(teamId, sessionId);

  if (!result.valid) {
    const code = reasonToCode[result.reason] ?? "unauthorized";
    const messages: Record<string, string> = {
      unauthorized:
        "Missing or invalid team_id (pass team_id in arguments, or set the X-Team-ID header) for this session",
      not_found: "Session not found",
      session_closed: "Session is closed",
    };
    throw new MCPError(code, messages[result.reason] ?? "Unauthorized");
  }

  return result.participant;
}
