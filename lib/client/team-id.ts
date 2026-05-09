'use client';

/**
 * Helpers for persisting the team_id issued by join_session / create_session.
 *
 * The web UI needs to remember which team_id it holds for each session so
 * users can refresh the page without re-joining. We store this in localStorage
 * keyed by session_id so tokens for different sessions don't collide.
 *
 * Key format: merkle:team_id:<session_id>
 *
 * SSR note: localStorage is browser-only. All exported functions guard against
 * server-side rendering by checking typeof window. Getters return null on the
 * server; setters are a no-op.
 */

const KEY_PREFIX = 'merkle:team_id:';

function key(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/** Returns the stored team_id for a session, or null if not found / SSR. */
export function getTeamId(sessionId: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(key(sessionId));
}

/** Persists a team_id for the given session. No-op during SSR. */
export function setTeamId(sessionId: string, teamId: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(key(sessionId), teamId);
}

/** Removes the stored team_id for the given session. No-op during SSR. */
export function clearTeamId(sessionId: string): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(key(sessionId));
}
