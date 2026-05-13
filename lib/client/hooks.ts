'use client';

/**
 * TanStack Query hooks that wrap every MCP tool.
 *
 * Auth is handled automatically: each hook reads the team_id from localStorage
 * via getTeamId(sessionId) and passes it as the X-Team-ID header. UI components
 * never need to manage the token directly.
 *
 * Pattern summary:
 *   - useQuery    — reads (list_participants, read_session_doc, get_history)
 *   - useMutation — writes (post_message, update_session_doc, etc.)
 *   - useMessageStream — custom hook that drives the long-poll loop via
 *                        useEffect + ref (NOT useQuery, because long-poll
 *                        doesn't fit Query's caching model: the call holds the
 *                        connection open for up to 30s and must re-fire
 *                        immediately after each return rather than waiting for
 *                        a staleTime window to expire).
 */

import { useQuery, useMutation, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useCallback } from 'react';
import { mcpCall, MCPClientError } from './mcp-client';
import { getTeamId, setTeamId, clearTeamId } from './team-id';
import type { Attachment } from '@/db/schema';

// ---------------------------------------------------------------------------
// Result types — one per MCP tool
// ---------------------------------------------------------------------------

export interface ParticipantRow {
  team_id: string;
  team_name: string;
  joined_at: string;
  last_seen_at: string;
  status: 'active' | 'idle' | 'disconnected';
}

export interface MessageRow {
  id: string;
  type: string;
  posted_by_team_id: string | null;
  content: unknown;
  posted_at: string;
  sequence: number;
  attachments?: Attachment[] | null;
}

// --- Session tools ---

export interface CreateSessionResult {
  session_id: string;
  team_id: string;
  cursor: number;
  title: string;
  description: string;
  /** Raw passcode returned only once at session creation time. */
  passcode: string;
}

export interface JoinSessionResult {
  team_id: string;
  cursor: number;
  participants: ParticipantRow[];
}

export interface LeaveSessionResult {
  ok: boolean;
}

export interface ListParticipantsResult {
  participants: ParticipantRow[];
}

export interface GetSessionResult {
  session_id: string;
  title: string;
  description: string;
  status: 'active' | 'closed';
  created_at: string;
  closed_at: string | null;
  session_doc_version: number;
  created_by_team_id?: string;
}

// --- Feed tools ---

export interface PostMessageResult {
  message_id: string;
  cursor: number;
  at: string;
}

export interface WaitForMessagesResult {
  messages: MessageRow[];
  next_cursor: number;
  session_closed: boolean;
}

export interface GetHistoryResult {
  messages: MessageRow[];
  next_cursor: number | null;
  has_more: boolean;
}

// --- Doc tools ---

export interface ReadSessionDocResult {
  content: string;
  version: number;
  title: string | null;
}

export interface WriteDocResult {
  version: number;
  updated_at: string;
}

export interface UpdateSessionMetadataResult {
  title: string;
  description: string;
  updated_at: string;
}

export interface ConcludeSessionResult {
  session_id: string;
  status: string;
  closed_at: string;
  doc_version: number;
}

export interface ReopenSessionResult {
  session_id: string;
  status: string;
  closed_at: null;
}

export interface SessionSummary {
  session_id: string;
  title: string;
  description: string;
  status: 'active' | 'closed';
  created_at: string;
  participant_count: number;
}

// ---------------------------------------------------------------------------
// Session list (dashboard)
// ---------------------------------------------------------------------------

/**
 * Lists sessions for the home-page dashboard.
 * No team_id required — list_sessions is intentionally open.
 * Auto-refreshes every 10 s so newly created/closed sessions appear promptly.
 */
export function useListSessions(options?: {
  status?: 'active' | 'closed' | 'all';
  limit?: number;
}) {
  const status = options?.status ?? 'active';
  const limit = options?.limit ?? 50;
  return useQuery({
    queryKey: ['sessions_list', status, limit],
    queryFn: () =>
      mcpCall<SessionSummary[]>('list_sessions', { status, limit }),
    refetchInterval: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle mutations
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Passcode localStorage helpers
// ---------------------------------------------------------------------------

const PASSCODE_PREFIX = 'merkle:passcode:';

/** Returns the stored passcode for a session, or null if not found / SSR. */
export function getPasscode(sessionId: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(`${PASSCODE_PREFIX}${sessionId}`);
}

/** Persists the passcode for the given session. No-op during SSR. */
export function setPasscode(sessionId: string, passcode: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(`${PASSCODE_PREFIX}${sessionId}`, passcode);
}

const LAST_USERNAME_KEY = 'merkle:last_username';

/** Returns the globally stored last-used username, or null if not found / SSR. */
export function getLastUsername(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(LAST_USERNAME_KEY);
  } catch {
    return null;
  }
}

/** Persists the last-used username globally. No-op during SSR. */
export function setLastUsername(name: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LAST_USERNAME_KEY, name);
  } catch {
    // ignore quota / security errors
  }
}

export function useCreateSession() {
  return useMutation({
    mutationFn: async (args: {
      title: string;
      description: string;
      creator_team_name: string;
    }): Promise<CreateSessionResult> => {
      return mcpCall<CreateSessionResult>('create_session', args);
    },
    onSuccess(data, variables) {
      setTeamId(data.session_id, data.team_id);
      // Seed passcode into localStorage so the creator can copy it later.
      setPasscode(data.session_id, data.passcode);
      // Remember the username globally for cross-session prefill.
      setLastUsername(variables.creator_team_name);
    },
  });
}

export function useJoinSession() {
  return useMutation({
    mutationFn: async (args: {
      session_id: string;
      team_name: string;
      passcode?: string;
    }): Promise<JoinSessionResult> => {
      const storedTeamId = getTeamId(args.session_id);
      return mcpCall<JoinSessionResult>('join_session', args, storedTeamId);
    },
    onSuccess(data, variables) {
      setTeamId(variables.session_id, data.team_id);
      // Persist passcode so re-entry pre-fills the field.
      if (variables.passcode) {
        setPasscode(variables.session_id, variables.passcode);
      }
      // Remember the username globally for cross-session prefill.
      setLastUsername(variables.team_name);
    },
  });
}

export function useLeaveSession() {
  return useMutation({
    mutationFn: async (args: {
      session_id: string;
      team_id: string;
    }): Promise<LeaveSessionResult> => {
      const teamId = getTeamId(args.session_id);
      return mcpCall<LeaveSessionResult>('leave_session', args, teamId);
    },
    onSuccess(_data, variables) {
      clearTeamId(variables.session_id);
    },
  });
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export function useParticipants(sessionId: string) {
  const teamId = getTeamId(sessionId);
  return useQuery({
    queryKey: ['participants', sessionId],
    queryFn: () =>
      mcpCall<ListParticipantsResult>('list_participants', { session_id: sessionId }, teamId),
    refetchInterval: 5_000,
    enabled: teamId !== null,
  });
}

export function useSession(sessionId: string) {
  const teamId = getTeamId(sessionId);
  return useQuery({
    queryKey: ['session', sessionId],
    queryFn: () =>
      mcpCall<GetSessionResult>('get_session', { session_id: sessionId }, teamId ?? undefined),
    refetchInterval: 10_000,
    enabled: teamId !== null,
    // Never retry on not_found / auth errors — session absence is definitive.
    // The default retry:3 would delay the not-found state by ~8s and mask the error.
    retry: (failureCount, error) => {
      if (error instanceof MCPClientError && (error.code === 'not_found' || error.code === 'unauthorized' || error.code === 'forbidden')) {
        return false;
      }
      return failureCount < 3;
    },
  });
}

// ---------------------------------------------------------------------------
// Session document
// ---------------------------------------------------------------------------

export function useSessionDoc(sessionId: string) {
  const teamId = getTeamId(sessionId);
  return useQuery({
    queryKey: ['session_doc', sessionId],
    queryFn: () =>
      mcpCall<ReadSessionDocResult>('read_session_doc', { session_id: sessionId }, teamId),
    refetchInterval: 5_000,
    enabled: teamId !== null,
  });
}

export function useUpdateSessionDoc() {
  return useMutation({
    mutationFn: async (args: {
      session_id: string;
      content: string;
      expected_version: number;
      title?: string | null;
    }): Promise<WriteDocResult> => {
      const teamId = getTeamId(args.session_id);
      return mcpCall<WriteDocResult>('update_session_doc', args, teamId);
    },
    // Surface 409 conflicts to the caller — the UI should re-read and let the
    // user retry. We do not swallow the error here.
  });
}

export function useAppendToSessionDoc() {
  return useMutation({
    mutationFn: async (args: {
      session_id: string;
      text: string;
      title?: string | null;
    }): Promise<WriteDocResult> => {
      const teamId = getTeamId(args.session_id);
      return mcpCall<WriteDocResult>('append_to_session_doc', args, teamId);
    },
  });
}

export function useUpdateSessionMetadata() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      session_id: string;
      title?: string;
      description?: string;
      reason: string;
    }): Promise<UpdateSessionMetadataResult> => {
      const teamId = getTeamId(args.session_id);
      return mcpCall<UpdateSessionMetadataResult>('update_session_metadata', args, teamId);
    },
    onSuccess(_data, variables) {
      void queryClient.invalidateQueries({ queryKey: ['session', variables.session_id] });
    },
  });
}

export function useConcludeSession() {
  return useMutation({
    mutationFn: async (args: {
      session_id: string;
      summary_section: string;
    }): Promise<ConcludeSessionResult> => {
      const teamId = getTeamId(args.session_id);
      return mcpCall<ConcludeSessionResult>('conclude_session', args, teamId);
    },
  });
}

export function useReopenSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      session_id: string;
      reason: string;
    }): Promise<ReopenSessionResult> => {
      const teamId = getTeamId(args.session_id);
      return mcpCall<ReopenSessionResult>('reopen_session', args, teamId);
    },
    onSuccess(_data, variables) {
      void queryClient.invalidateQueries({ queryKey: ['session', variables.session_id] });
    },
  });
}

// ---------------------------------------------------------------------------
// Feed mutations
// ---------------------------------------------------------------------------

export function usePostMessage() {
  return useMutation({
    mutationFn: async (args: {
      session_id: string;
      content: { text: string };
      type?: string;
      attachments?: Attachment[];
    }): Promise<PostMessageResult> => {
      const teamId = getTeamId(args.session_id);
      return mcpCall<PostMessageResult>('post_message', args, teamId);
    },
  });
}

// ---------------------------------------------------------------------------
// History (cold read / initial backfill)
// ---------------------------------------------------------------------------

/**
 * One-shot query for the most-recent batch of messages.
 * Use `useInfiniteHistory` if you need full backwards pagination in the UI.
 */
export function useHistory(
  sessionId: string,
  options?: { beforeCursor?: number; limit?: number },
) {
  const teamId = getTeamId(sessionId);
  return useQuery({
    queryKey: ['history', sessionId, options],
    queryFn: () =>
      mcpCall<GetHistoryResult>(
        'get_history',
        {
          session_id: sessionId,
          before_cursor: options?.beforeCursor ?? null,
          limit: options?.limit ?? 100,
        },
        teamId,
      ),
    enabled: teamId !== null,
  });
}

/**
 * Infinite-query variant for backwards-paginated history.
 * Each page goes further into the past; use `fetchNextPage` to load older messages.
 */
export function useInfiniteHistory(sessionId: string) {
  const teamId = getTeamId(sessionId);
  return useInfiniteQuery({
    queryKey: ['history_infinite', sessionId],
    queryFn: ({ pageParam }) =>
      mcpCall<GetHistoryResult>(
        'get_history',
        {
          session_id: sessionId,
          before_cursor: pageParam ?? null,
          limit: 100,
        },
        teamId,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.has_more && lastPage.next_cursor != null
        ? lastPage.next_cursor
        : undefined,
    enabled: teamId !== null,
  });
}

// ---------------------------------------------------------------------------
// useMessageStream — long-poll live feed driver
// ---------------------------------------------------------------------------

/**
 * Strategy: effect + ref (NOT useQuery).
 *
 * Rationale: `wait_for_messages` holds the HTTP connection open for up to 30s.
 * TanStack Query's caching model assumes calls are short-lived and re-fires
 * based on staleness windows. A long-poll that blocks for 30s would interact
 * badly with staleTime / gcTime: the query would be considered "fresh" for up
 * to staleTime ms after each return, introducing idle gaps in the feed.
 *
 * Instead we use a self-rescheduling effect:
 *   1. On mount, backfill from get_history (most recent batch).
 *   2. Enter the poll loop: call wait_for_messages with the latest cursor.
 *   3. On return, append new messages to state, advance the cursor, repeat.
 *   4. If session_closed: true arrives, stop and surface the closed flag.
 *   5. After IDLE_LIMIT consecutive empty polls, surface an "idle" indicator.
 *   6. On unmount, set a cancelled ref so the in-flight poll is discarded.
 *
 * The long-poll timeout is 30s server-side; we add 5s of client headroom
 * for network transit, giving a 35s AbortSignal timeout per call.
 *
 * Caveats for Phase 4b:
 *   - Messages are stored in component state; the array grows unbounded for
 *     very long sessions. Phase 4b may want to virtualise the feed or cap the
 *     in-memory list and rely on get_history for older pages.
 *   - The effect re-fires on sessionId / teamId change. If teamId transitions
 *     from null → string (i.e. user joins mid-render), the stream starts
 *     automatically without needing the parent to remount.
 */

const IDLE_LIMIT = 10;
const WAIT_TIMEOUT_MS = 35_000; // client-side abort: 35s > server's 30s max

export interface UseMessageStreamResult {
  messages: MessageRow[];
  sessionClosed: boolean;
  isIdle: boolean;
  error: Error | null;
}

export function useMessageStream(sessionId: string): UseMessageStreamResult {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [sessionClosed, setSessionClosed] = useState(false);
  const [isIdle, setIsIdle] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Mutable refs so the effect closure always reads the latest values without
  // needing them listed as dependencies (which would restart the loop).
  const cursorRef = useRef<number>(0);
  const cancelledRef = useRef(false);
  const idleCountRef = useRef(0);

  // Read teamId from localStorage on every render; put it in a ref so the
  // poll loop always uses the current value without restarting on change.
  const teamId = getTeamId(sessionId);
  const teamIdRef = useRef(teamId);
  teamIdRef.current = teamId;

  // Stable callback so the effect dependency is the sessionId only.
  const runStream = useCallback(async () => {
    cancelledRef.current = false;
    idleCountRef.current = 0;
    cursorRef.current = 0;
    setMessages([]);
    setSessionClosed(false);
    setIsIdle(false);
    setError(null);

    const currentTeamId = teamIdRef.current;
    if (!currentTeamId) return; // not joined yet — effect will re-run when teamId changes

    // --- Step 1: initial backfill ---
    try {
      const history = await mcpCall<GetHistoryResult>(
        'get_history',
        { session_id: sessionId, before_cursor: null, limit: 100 },
        currentTeamId,
      );
      if (cancelledRef.current) return;
      if (history.messages.length > 0) {
        setMessages((prev) => {
          const seenIds = new Set(prev.map((m) => m.id));
          const fresh = history.messages.filter((m) => !seenIds.has(m.id));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
        // Advance cursor to the highest sequence seen in history so the poll
        // loop only fetches messages that arrive after the backfill.
        const last = history.messages[history.messages.length - 1];
        if (last) cursorRef.current = last.sequence;
      }
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // --- Step 2: long-poll loop ---
    while (!cancelledRef.current) {
      const loopTeamId = teamIdRef.current;
      if (!loopTeamId) break; // team_id cleared (user left) — stop the loop

      const abortController = new AbortController();
      const timeoutHandle = setTimeout(
        () => abortController.abort(),
        WAIT_TIMEOUT_MS,
      );

      let result: WaitForMessagesResult;
      try {
        result = await mcpCall<WaitForMessagesResult>(
          'wait_for_messages',
          {
            session_id: sessionId,
            since_cursor: cursorRef.current,
            timeout: 30,
          },
          loopTeamId,
          abortController.signal,
        );
      } catch (err) {
        clearTimeout(timeoutHandle);
        if (cancelledRef.current) return;
        // Surface errors but don't crash the loop — let Phase 4b decide retry strategy
        if (err instanceof MCPClientError && err.code === 'timeout') {
          // Client-side timeout (shouldn't happen normally since server returns at 30s)
          // Just continue the loop.
          continue;
        }
        setError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      clearTimeout(timeoutHandle);

      if (cancelledRef.current) return;

      if (result.session_closed) {
        if (result.messages.length > 0) {
          setMessages((prev) => {
            const seenIds = new Set(prev.map((m) => m.id));
            const fresh = result.messages.filter((m) => !seenIds.has(m.id));
            return fresh.length > 0 ? [...prev, ...fresh] : prev;
          });
        }
        setSessionClosed(true);
        return; // stop the loop — session is concluded
      }

      if (result.messages.length > 0) {
        setMessages((prev) => {
          const seenIds = new Set(prev.map((m) => m.id));
          const fresh = result.messages.filter((m) => !seenIds.has(m.id));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
        cursorRef.current = result.next_cursor;
        idleCountRef.current = 0;
        setIsIdle(false);
      } else {
        // Empty poll — increment idle counter per README poll-budget rule
        idleCountRef.current += 1;
        if (idleCountRef.current >= IDLE_LIMIT) {
          setIsIdle(true);
          // Surface idle but keep the loop running — the UI can show a notice
          // and the user can dismiss it; we don't hard-stop here.
          // Phase 4b can add a manual "stop polling" control if desired.
        }
      }
    }
  }, [sessionId]);

  useEffect(() => {
    // (Re-)start the stream when sessionId or teamId changes.
    // teamId is not in the dep array because we don't want a teamId change alone
    // to restart the already-running loop. Instead, the loop reads teamIdRef
    // on each iteration. The effect only restarts when sessionId changes
    // (navigating to a different session).
    runStream().catch((err: unknown) => {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    return () => {
      cancelledRef.current = true;
    };
  }, [runStream]);

  return { messages, sessionClosed, isIdle, error };
}
