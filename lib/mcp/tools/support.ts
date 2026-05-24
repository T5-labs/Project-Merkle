/**
 * MCP tool implementations for the "support session" feature.
 *
 * Tools:
 *   support_refresh_tickets      — walk the vault, replace the session's pushed
 *                                  ticket option set, broadcast updates.
 *   support_get_selected_ticket  — return the session's currently-selected
 *                                  ticket option (key/project/number) or null.
 *   support_read_selected_ticket — read the markdown body of the selected
 *                                  ticket via the vault module.
 *   support_append_issue         — append a single bullet to the selected
 *                                  ticket's Issues Found in Support section.
 *
 * SERVER-ONLY — all helpers funnel through repos.ts and vault.ts.
 *
 * SAFETY CONTRACT (this module is layer 1 of the contract — vault.ts is layer 2):
 *   1. `support_append_issue`'s Zod schema is `.strict()` and accepts ONLY
 *      `session_id` and `issue_text`. NO FILE PATH INPUT EVER.
 *   2. Every tool calls `requireMembership` (auth gate) and then
 *      `ensureSupportSession` (support-only gate).
 *   3. `appendIssueToTicket` is called with `key` sourced exclusively from
 *      `sessions.selected_ticket_key`, never from agent input.
 *   4. `VaultTicket.absolutePath` is server-internal — only `key/project/number`
 *      and `pushedByTeamId` flow into the DB rows we insert.
 *
 * SDK note (v1.29.0): server.tool() expects a raw ZodRawShapeCompat object
 * (i.e. a plain { key: ZodType } map) as the second argument, NOT a wrapped
 * z.object(...) instance. We define each schema as a z.object for type
 * inference then pass `.shape` to server.tool().
 */
import "server-only";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";

import { requireMembership } from "@/lib/mcp/auth";
import { MCPError, type ErrorCode } from "@/lib/mcp/errors";
import { broadcastSystemMessage } from "@/lib/mcp/broadcast";
import {
  getSessionById,
  getSupportSessionState,
  replaceSupportTicketOptions,
  findSupportTicketOption,
  touchParticipantHeartbeat,
} from "@/lib/mcp/repos";
import {
  listVaultTickets,
  readTicketContent,
  appendIssueToTicket,
  VaultError,
  type VaultErrorCode,
} from "@/lib/support/vault";
import type { NewSupportTicketOption } from "@/db/schema";

// Shorthand alias matching what the SDK actually passes into tool callbacks.
type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const supportRefreshTicketsSchema = z.object({
  session_id: z.string().uuid(),
  // Optional v0.12 auth path — supersedes X-Team-ID header when present.
  team_id: z.string().uuid().optional(),
});

const supportGetSelectedTicketSchema = z.object({
  session_id: z.string().uuid(),
  // Optional v0.12 auth path — supersedes X-Team-ID header when present.
  team_id: z.string().uuid().optional(),
});

const supportReadSelectedTicketSchema = z.object({
  session_id: z.string().uuid(),
  // Optional v0.12 auth path — supersedes X-Team-ID header when present.
  team_id: z.string().uuid().optional(),
});

/**
 * `.strict()` is LOAD-BEARING here — it ensures the agent cannot smuggle a
 * `path`, `key`, `file`, or any other unexpected field. Per the safety
 * contract, the only inputs accepted are the session id, the optional v0.12
 * auth credential (team_id), and the issue body.
 */
const supportAppendIssueSchema = z
  .object({
    session_id: z.string().uuid(),
    // Optional v0.12 auth path — supersedes X-Team-ID header when present.
    team_id: z.string().uuid().optional(),
    issue_text: z.string().min(1).max(2000),
  })
  .strict();

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/**
 * Loads the support-session state row for the session, asserts the session
 * exists, and asserts it is flagged as a support session. Returns the state
 * so callers can reuse `selectedTicketKey` without a second query.
 */
async function ensureSupportSession(sessionId: string) {
  const state = await getSupportSessionState(sessionId);
  if (!state) {
    throw new MCPError("not_found", "Session not found");
  }
  if (!state.isSupportSession) {
    throw new MCPError("forbidden", "Not a support session");
  }
  return state;
}

/**
 * Maps a VaultErrorCode onto the closest MCPError ErrorCode. `not_configured`
 * collapses to `internal` because it is a server-side misconfiguration, not a
 * client-fixable condition.
 */
const VAULT_TO_MCP_CODE: Record<VaultErrorCode, ErrorCode> = {
  not_configured: "internal",
  bad_request: "bad_request",
  forbidden: "forbidden",
  not_found: "not_found",
  internal: "internal",
};

function mapVaultError(err: unknown): never {
  if (err instanceof VaultError) {
    const code = VAULT_TO_MCP_CODE[err.code] ?? "internal";
    throw new MCPError(code, err.message);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSupportTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // support_refresh_tickets
  // -------------------------------------------------------------------------
  // Walks the on-disk vault one level deep and replaces the session's stored
  // ticket option set in a single transaction. If the previously-selected
  // ticket is no longer in the new option set, the selection is cleared and a
  // support_ticket_selected broadcast with ticket_key=null is emitted before
  // the support_tickets_updated broadcast.
  server.tool(
    "support_refresh_tickets",
    supportRefreshTicketsSchema.shape,
    async (
      input: z.infer<typeof supportRefreshTicketsSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, team_id } = input;

      // Auth — must be a session member (args-first team_id, header fallback).
      const participant = await requireMembership(extra, session_id, team_id);
      await touchParticipantHeartbeat(session_id, participant.teamId);

      // Support-session gate.
      await ensureSupportSession(session_id);

      // Write-gate against closed sessions (mirrors doc.ts pattern).
      const session = await getSessionById(session_id);
      if (!session) throw new MCPError("not_found", "Session not found");
      if (session.status === "closed") {
        throw new MCPError(
          "forbidden",
          "Session is closed — ticket options are read-only",
        );
      }

      // Enumerate the vault. Map VaultError → MCPError so the client sees a
      // structured failure (e.g. SWT_OBSIDIAN_PATH unset → internal).
      let tickets;
      try {
        tickets = await listVaultTickets();
      } catch (err) {
        mapVaultError(err);
      }

      // Strip absolutePath here — that field is server-internal per SWE-2's
      // contract and must never reach the DB or the wire.
      const rows: NewSupportTicketOption[] = tickets!.map((t) => ({
        sessionId: session_id,
        ticketKey: t.key,
        project: t.project,
        number: t.number,
        pushedByTeamId: participant.teamId,
      }));

      const result = await replaceSupportTicketOptions(session_id, rows);

      // If the prior selection got dropped, broadcast the clear FIRST so
      // listeners see selection state become consistent before they re-read.
      if (result.clearedSelection) {
        await broadcastSystemMessage(session_id, {
          event: "support_ticket_selected",
          ticket_key: null,
          previous_ticket_key: result.previousSelection,
          changed_by_team_id: participant.teamId,
          changed_by_team_name: participant.teamName,
        });
      }

      await broadcastSystemMessage(session_id, {
        event: "support_tickets_updated",
        by_team_id: participant.teamId,
        by_team_name: participant.teamName,
        count: result.count,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, count: result.count }),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // support_get_selected_ticket
  // -------------------------------------------------------------------------
  // Returns the metadata of the session's currently-selected ticket option, or
  // { key: null } when no selection is set. Defensively falls back to
  // { key: null } if the stored selected_ticket_key has somehow drifted out of
  // the options table (shouldn't happen given replaceSupportTicketOptions
  // clears it, but we choose silent-null over throwing for read paths).
  server.tool(
    "support_get_selected_ticket",
    supportGetSelectedTicketSchema.shape,
    async (
      input: z.infer<typeof supportGetSelectedTicketSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, team_id } = input;

      const participant = await requireMembership(extra, session_id, team_id);
      await touchParticipantHeartbeat(session_id, participant.teamId);

      const state = await ensureSupportSession(session_id);

      if (state.selectedTicketKey === null) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ key: null }) },
          ],
        };
      }

      const option = await findSupportTicketOption(
        session_id,
        state.selectedTicketKey,
      );
      if (option === null) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ key: null }) },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              key: option.ticketKey,
              project: option.project,
              number: option.number,
            }),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // support_read_selected_ticket
  // -------------------------------------------------------------------------
  // Reads the markdown body of the session's currently-selected ticket file
  // via the vault module. The key is sourced from the DB, never from the
  // caller, so the agent cannot redirect the read by argument-smuggling.
  server.tool(
    "support_read_selected_ticket",
    supportReadSelectedTicketSchema.shape,
    async (
      input: z.infer<typeof supportReadSelectedTicketSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, team_id } = input;

      const participant = await requireMembership(extra, session_id, team_id);
      await touchParticipantHeartbeat(session_id, participant.teamId);

      const state = await ensureSupportSession(session_id);

      if (state.selectedTicketKey === null) {
        throw new MCPError("bad_request", "No ticket selected");
      }

      let result;
      try {
        result = await readTicketContent(state.selectedTicketKey);
      } catch (err) {
        mapVaultError(err);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              key: result!.key,
              content: result!.content,
            }),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // support_append_issue
  // -------------------------------------------------------------------------
  // Appends a single issue line to the selected ticket's vault file. This is
  // the only WRITE path into the vault from the MCP surface. The append
  // operation itself is gated by vault.ts (atomic tmp+rename, single bullet,
  // no overwrite), and we layer on:
  //   - .strict() Zod (no file-path argument can ever be passed)
  //   - session must be a support session
  //   - session must not be closed
  //   - selected_ticket_key must be set
  //   - selected_ticket_key must still match a pushed option (belt-and-braces)
  server.tool(
    "support_append_issue",
    supportAppendIssueSchema.shape,
    async (
      input: z.infer<typeof supportAppendIssueSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, team_id, issue_text } = input;

      const participant = await requireMembership(extra, session_id, team_id);
      await touchParticipantHeartbeat(session_id, participant.teamId);

      // Support-session gate.
      const state = await ensureSupportSession(session_id);

      // Write-gate against closed sessions.
      const session = await getSessionById(session_id);
      if (!session) throw new MCPError("not_found", "Session not found");
      if (session.status === "closed") {
        throw new MCPError(
          "forbidden",
          "Session is closed — vault writes are disabled",
        );
      }

      // Layer-1 safety check #1: selection must be set.
      if (state.selectedTicketKey === null) {
        throw new MCPError("bad_request", "No ticket selected");
      }

      // Layer-1 safety check #2: the selected key must still exist in the
      // session's pushed option set. This is belt-and-braces — the schema
      // truncate-and-replace logic in replaceSupportTicketOptions already
      // clears the selection if the key drops out, but we re-verify here so a
      // race between refresh and append cannot redirect a write.
      const option = await findSupportTicketOption(
        session_id,
        state.selectedTicketKey,
      );
      if (option === null) {
        throw new MCPError(
          "forbidden",
          "Selected ticket no longer in available list",
        );
      }

      // Call the blessed write path. The `key` is sourced exclusively from
      // sessions.selected_ticket_key (state.selectedTicketKey), per SWE-2's
      // contract — NEVER from agent input.
      let result;
      try {
        result = await appendIssueToTicket({
          key: state.selectedTicketKey,
          issueText: issue_text,
          byTeamName: participant.teamName,
        });
      } catch (err) {
        mapVaultError(err);
      }

      await broadcastSystemMessage(session_id, {
        event: "support_issue_appended",
        by_team_id: participant.teamId,
        by_team_name: participant.teamName,
        ticket_key: state.selectedTicketKey,
        // broadcastSystemMessage overwrites `at` with its own timestamp per
        // SWE-1's note. Acceptable for v1 — broadcast time, not write time.
        at: result!.appendedAt,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              ticket_key: result!.key,
              appended_at: result!.appendedAt,
            }),
          },
        ],
      };
    },
  );
}
