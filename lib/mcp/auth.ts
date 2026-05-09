/**
 * Auth helpers for MCP tool implementations.
 *
 * SERVER-ONLY — this module queries the participants table.
 *
 * The MCP SDK (v1.29.0) exposes the originating HTTP request through the
 * RequestHandlerExtra.requestInfo field (type RequestInfo from the SDK's types.d.ts).
 * requestInfo.headers is typed as IsomorphicHeaders = Record<string, string | string[] | undefined>.
 *
 * Usage inside a tool handler:
 *   server.tool('my_tool', schema, async (args, extra) => {
 *     const participant = await requireMembership(extra, args.session_id);
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
// Header extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the X-Team-ID header from the MCP tool call's request context.
 * Returns the header value as a string, or null if absent.
 *
 * The SDK passes the original HTTP request headers via extra.requestInfo.headers
 * (IsomorphicHeaders). Header names from the HTTP layer are lowercased by the
 * SDK's Web Standard transport before being placed into this map.
 */
export function extractTeamId(extra: ToolExtra): string | null {
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
 * Convenience wrapper: extracts the team_id header, validates membership, and
 * returns the Participant row on success. Throws MCPError on any failure so
 * tool handlers can call this as a single auth guard.
 */
export async function requireMembership(
  extra: ToolExtra,
  sessionId: string,
): Promise<Participant> {
  const teamId = extractTeamId(extra);
  const result = await validateMembership(teamId, sessionId);

  if (!result.valid) {
    const code = reasonToCode[result.reason] ?? "unauthorized";
    const messages: Record<string, string> = {
      unauthorized: "Missing or invalid X-Team-ID for this session",
      not_found: "Session not found",
      session_closed: "Session is closed",
    };
    throw new MCPError(code, messages[result.reason] ?? "Unauthorized");
  }

  return result.participant;
}
