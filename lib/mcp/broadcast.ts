/**
 * System-message broadcast helper.
 *
 * SERVER-ONLY — this module writes to the database.
 *
 * IMPORTANT: All system messages (team_joined, team_left, team_dropped,
 * team_rejoined, session_metadata_updated, session_concluded) MUST be posted through
 * broadcastSystemMessage. Tool handlers MUST NOT insert into the messages table
 * directly for system-type events. This enforces the content shape convention
 * and ensures cursors advance correctly.
 */
import "server-only";

import { insertMessage } from "@/lib/mcp/repos";

// ---------------------------------------------------------------------------
// Event union
// ---------------------------------------------------------------------------

/**
 * Support-session events:
 *   - support_tickets_updated: the convener pushed a new set of ticket options.
 *   - support_ticket_selected: the active ticket for the session changed (or
 *     was cleared — ticket_key is null in that case).
 *   - support_issue_appended: an issue line was appended to the selected
 *     ticket's vault file. The issue text itself is NEVER included in the
 *     event payload — it lives only in the vault file on disk.
 */
export type SystemEvent =
  | { event: "team_joined"; team: string }
  | { event: "team_left"; team: string }
  | { event: "team_dropped"; team: string; team_id: string }
  | { event: "team_rejoined"; team: string; team_id: string }
  | {
      event: "session_metadata_updated";
      by: string;
      changes: {
        title?: { from: string; to: string };
        description?: { from: string; to: string };
      };
      reason: string;
    }
  | { event: "session_started"; by: string; team_id?: string }
  | { event: "session_concluded"; by: string; summary: string }
  | { event: "session_reopened"; by: string; team_id: string; reason: string }
  | { event: "doc_updated"; by: string; team_id: string }
  | { event: "doc_appended"; by: string; team_id: string }
  | {
      event: "support_tickets_updated";
      by_team_id: string;
      by_team_name: string;
      count: number;
    }
  | {
      event: "support_ticket_selected";
      ticket_key: string | null;
      previous_ticket_key: string | null;
      changed_by_team_id: string;
      changed_by_team_name: string;
    }
  | {
      event: "support_issue_appended";
      by_team_id: string;
      by_team_name: string;
      ticket_key: string;
      at: string;
    };

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/**
 * Inserts a system message into the feed for the given session and returns
 * the new message's id and sequence (cursor).
 *
 * The posted_by_team_id is null for all system messages per schema convention.
 */
export async function broadcastSystemMessage(
  sessionId: string,
  event: SystemEvent,
): Promise<{ messageId: string; cursor: number }> {
  const content = {
    ...event,
    at: new Date().toISOString(),
  };

  const { id, sequence } = await insertMessage({
    sessionId,
    postedByTeamId: null,
    type: "system",
    content,
  });

  return { messageId: id, cursor: sequence };
}
