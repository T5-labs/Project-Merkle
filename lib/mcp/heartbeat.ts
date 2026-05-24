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

import { and, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/index";
import { messages, participants } from "@/db/schema";
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
 * `excludeTeamId` (optional): if provided, the team with this id is omitted
 * from the sweep entirely. Callers pass their own caller's team_id here to
 * avoid the race where a team that just made a tool call gets swept by the
 * sweep that runs in the same handler (before, or concurrent with, the
 * heartbeat update). The team that just made a request is by definition
 * fresh — never a sweep candidate.
 *
 * Returns the list of team_ids that were swept (for logging/debug).
 */
export async function sweepStaleParticipants(
  sessionId: string,
  excludeTeamId?: string | null,
): Promise<string[]> {
  const threshold = new Date(Date.now() - HEARTBEAT_IDLE_THRESHOLD_MS);

  // Select candidates: stored as 'active' but heartbeat is stale. Optionally
  // exclude the caller's own team to avoid a same-transaction race.
  const baseConds = [
    eq(participants.sessionId, sessionId),
    eq(participants.status, "active"),
    lt(participants.lastSeenAt, threshold),
  ];
  if (excludeTeamId) {
    baseConds.push(ne(participants.teamId, excludeTeamId));
  }

  const stale = await db
    .select({
      teamId: participants.teamId,
      teamName: participants.teamName,
    })
    .from(participants)
    .where(and(...baseConds));

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

// ---------------------------------------------------------------------------
// Reactivation on heartbeat (Fix C)
// ---------------------------------------------------------------------------

/**
 * If the given participant row is currently `disconnected` AND was last
 * dropped by the sweep (not by an explicit `leave_session`), flip status back
 * to `active` and broadcast a `team_rejoined` system message.
 *
 * Differentiation: we inspect the most recent `team_dropped` / `team_left`
 * system message for this team in this session. If `team_dropped` is more
 * recent (or `team_left` doesn't exist), the disconnect was caused by the
 * heartbeat sweep and a fresh tool call counts as the agent coming back. If
 * `team_left` is more recent, the team deliberately left and MUST re-call
 * `join_session` — we do NOT auto-reactivate.
 *
 * This is best-effort: if the event lookup or status flip fails, the caller
 * should swallow the error — the tool call itself does not depend on it.
 */
export async function reactivateIfStaleDropped(
  sessionId: string,
  teamId: string,
  teamName: string,
  currentStatus: "active" | "idle" | "disconnected",
): Promise<boolean> {
  // Only reactivate disconnected rows; active/idle have nothing to do.
  if (currentStatus !== "disconnected") return false;

  // Most recent team_left or team_dropped event for this team in this session.
  // Use JSONB `->>` operator on the content column to match the event name
  // and the team_id payload field. team_dropped includes team_id explicitly;
  // team_left does not, so we match by team name as the secondary field
  // (team_left content shape: { event, team, at }).
  const recent = await db
    .select({
      event: sql<string>`${messages.content}->>'event'`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.type, "system"),
        or(
          and(
            sql`${messages.content}->>'event' = 'team_dropped'`,
            sql`${messages.content}->>'team_id' = ${teamId}`,
          ),
          and(
            sql`${messages.content}->>'event' = 'team_left'`,
            sql`${messages.content}->>'team' = ${teamName}`,
          ),
        ),
      ),
    )
    .orderBy(desc(messages.sequence))
    .limit(1);

  const last = recent[0];
  // If we can't find a relevant event, default to reactivating — the row is
  // disconnected for some legacy/unknown reason and a fresh call is the
  // strongest signal we have that the agent is alive.
  const shouldReactivate = !last || last.event === "team_dropped";
  if (!shouldReactivate) return false;

  // Conditional UPDATE: only flips if still 'disconnected' (idempotency guard
  // against two concurrent reactivations).
  const updated = await db
    .update(participants)
    .set({ status: "active" })
    .where(
      and(
        eq(participants.sessionId, sessionId),
        eq(participants.teamId, teamId),
        eq(participants.status, "disconnected"),
      ),
    )
    .returning({ teamId: participants.teamId });

  if (updated.length === 0) {
    // A concurrent call already reactivated; skip the broadcast.
    return false;
  }

  // Post the audit-trail event only when we actually mutated the row.
  try {
    await broadcastSystemMessage(sessionId, {
      event: "team_rejoined",
      team: teamName,
      team_id: teamId,
    });
  } catch {
    // Best-effort: a failed broadcast does not roll back the status flip.
  }

  return true;
}
