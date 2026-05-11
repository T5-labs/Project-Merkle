/**
 * Heartbeat thresholds and lazy sweep helpers.
 *
 * SERVER-ONLY — this module writes to the database.
 *
 * Status derivation model:
 *   < 3m since last_seen_at   → active
 *   3m–15m since last_seen_at → idle
 *   > 15m since last_seen_at  → disconnected (sweep candidate)
 *
 * 180s active matches typical agent task duration; 900s disconnect forgives
 * short detours and user conversations without flapping.
 *
 * The sweep is "lazy on read": called at the top of every read-path tool handler
 * (list_participants, get_session, get_history, wait_for_messages) before the
 * main query executes, so the returned data always reflects up-to-date status.
 * The sweep is best-effort — if it fails, the read continues normally.
 *
 * Concurrency safety: the UPDATE uses a conditional WHERE clause
 * (status = 'active' AND last_seen_at < threshold) so two concurrent sweeps
 * targeting the same participant are idempotent: the second UPDATE finds no
 * matching rows and returns an empty RETURNING set, skipping the audit message.
 */
import "server-only";

import { and, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db/index";
import { participants } from "@/db/schema";
import { broadcastSystemMessage } from "@/lib/mcp/broadcast";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Participants last seen within this window are considered active. */
export const HEARTBEAT_ACTIVE_THRESHOLD_MS = 180_000;

/** Participants last seen between ACTIVE and IDLE thresholds are considered idle. */
export const HEARTBEAT_IDLE_THRESHOLD_MS = 900_000;

// ---------------------------------------------------------------------------
// Status derivation (pure — no DB access)
// ---------------------------------------------------------------------------

/**
 * Derives the logical presence status from a participant's last_seen_at timestamp.
 * Does NOT write to the database — use this when serializing rows for the wire
 * to avoid a write on every read for recently-active participants.
 */
export function deriveStatusFromHeartbeat(
  lastSeenAt: Date,
  now: Date = new Date(),
): "active" | "idle" | "disconnected" {
  const elapsed = now.getTime() - lastSeenAt.getTime();
  if (elapsed < HEARTBEAT_ACTIVE_THRESHOLD_MS) return "active";
  if (elapsed < HEARTBEAT_IDLE_THRESHOLD_MS) return "idle";
  return "disconnected";
}

// ---------------------------------------------------------------------------
// Lazy sweep
// ---------------------------------------------------------------------------

/**
 * Sweeps stale-active participants in a session.
 *
 * For each participant whose stored status is 'active' but whose last_seen_at
 * is older than HEARTBEAT_IDLE_THRESHOLD_MS (15 minutes), this function:
 *   1. Atomically flips status → 'disconnected' using a conditional UPDATE.
 *   2. If the UPDATE mutated the row (returned via RETURNING), posts a
 *      team_dropped system message to the feed.
 *
 * The conditional UPDATE ensures two concurrent sweeps are idempotent: the
 * second one finds the status already 'disconnected' and skips the audit post.
 *
 * Returns the list of team_ids that were swept (for logging/debug).
 */
export async function sweepStaleParticipants(
  sessionId: string,
): Promise<string[]> {
  const threshold = new Date(Date.now() - HEARTBEAT_IDLE_THRESHOLD_MS);

  // Select candidates: stored as 'active' but heartbeat is stale.
  const stale = await db
    .select({
      teamId: participants.teamId,
      teamName: participants.teamName,
    })
    .from(participants)
    .where(
      and(
        eq(participants.sessionId, sessionId),
        eq(participants.status, "active"),
        lt(participants.lastSeenAt, threshold),
      ),
    );

  if (stale.length === 0) return [];

  const swept: string[] = [];

  for (const p of stale) {
    // Conditional UPDATE: only flips if still 'active' (idempotency guard).
    const updated = await db
      .update(participants)
      .set({ status: "disconnected" })
      .where(
        and(
          eq(participants.sessionId, sessionId),
          eq(participants.teamId, p.teamId),
          eq(participants.status, "active"),
          lt(participants.lastSeenAt, threshold),
        ),
      )
      .returning({ teamId: participants.teamId });

    if (updated.length === 0) {
      // Another concurrent sweep already handled this participant.
      continue;
    }

    // Post the audit trail message only when we actually mutated the row.
    try {
      await broadcastSystemMessage(sessionId, {
        event: "team_dropped",
        team: p.teamName,
        team_id: p.teamId,
      });
    } catch {
      // Best-effort: a failed broadcast does not roll back the status flip.
    }

    swept.push(p.teamId);
  }

  return swept;
}
