/**
 * System-message broadcast helper.
 *
 * SERVER-ONLY — this module writes to the database.
 *
 * IMPORTANT: All system messages (team_joined, team_left, team_dropped,
 * session_metadata_updated, session_concluded) MUST be posted through
 * broadcastSystemMessage. Tool handlers MUST NOT insert into the messages table
 * directly for system-type events. This enforces the content shape convention
 * and ensures cursors advance correctly.
 */
import "server-only";

import { insertMessage } from "@/lib/mcp/repos";

// ---------------------------------------------------------------------------
// Event union
// ---------------------------------------------------------------------------

export type SystemEvent =
  | { event: "team_joined"; team: string }
  | { event: "team_left"; team: string }
  | { event: "team_dropped"; team: string; team_id: string }
  | {
      event: "session_metadata_updated";
      by: string;
      changes: {
        title?: { from: string; to: string };
        description?: { from: string; to: string };
      };
      reason: string;
    }
  | { event: "session_concluded"; by: string }
  | { event: "doc_updated"; by: string; team_id: string }
  | { event: "doc_appended"; by: string; team_id: string };

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
