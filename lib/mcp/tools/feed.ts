/**
 * MCP tool implementations for the transaction feed.
 *
 * Tools:
 *   post_message        — post a chat message to the session feed (auth required)
 *   wait_for_messages   — long-poll for new messages after a cursor (auth required)
 *   get_history         — paginated backwards read of feed history (auth required)
 *
 * SERVER-ONLY — all helpers imported here write to or read from Postgres.
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
import { MCPError } from "@/lib/mcp/errors";
import {
  getSessionById,
  insertMessage,
  getMessagesAfter,
  getMessagesBefore,
  touchParticipantHeartbeat,
} from "@/lib/mcp/repos";
import { sweepStaleParticipants } from "@/lib/mcp/heartbeat";
import type { Attachment, Message } from "@/db/schema";

// Shorthand alias for the extra type used in all handlers.
type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const postMessageSchema = z.object({
  session_id: z.string().uuid(),
  // content is the chat payload: { text: string }
  content: z.object({ text: z.string() }).strict(),
  // type is optional; only "chat" is allowed for agents
  type: z.string().optional(),
  // attachments: optional array of base64-encoded images (3MB total cap)
  attachments: z
    .array(
      z.object({
        type: z.literal('image'),
        mime: z.string(),
        data: z.string(), // raw base64, no "data:" URI prefix
      }),
    )
    .optional(),
});

const waitForMessagesSchema = z.object({
  session_id: z.string().uuid(),
  // since_cursor is the sequence value to start after; 0 means "from the beginning"
  since_cursor: z.number().int().nonnegative(),
  // timeout in seconds; optional, default 30, clamped to [1, 30]
  timeout: z.number().optional(),
});

const getHistorySchema = z.object({
  session_id: z.string().uuid(),
  // before_cursor: if absent or null, returns the most-recent batch
  before_cursor: z.number().int().nonnegative().optional().nullable(),
  // limit: default 100, max 500; values above 500 silently clamp to 100 per README
  limit: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Maps a Message row to the wire shape returned by both wait_for_messages and
 * get_history. Keeps the two tool return shapes in sync from one place.
 */
function serializeMessage(msg: Message): {
  id: string;
  type: string;
  posted_by_team_id: string | null;
  content: unknown;
  posted_at: string;
  sequence: number;
  attachments?: Attachment[] | null;
} {
  return {
    id: msg.id,
    type: msg.type,
    posted_by_team_id: msg.postedByTeamId,
    content: msg.content,
    posted_at: msg.postedAt.toISOString(),
    sequence: msg.sequence,
    attachments: msg.attachments,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeedTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // post_message
  // -------------------------------------------------------------------------
  // Agents may only post type="chat". System messages are server-generated only.
  // Rejected if session is closed (forbidden). Content must have non-empty text.
  server.tool(
    "post_message",
    postMessageSchema.shape,
    async (
      input: z.infer<typeof postMessageSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, content, type, attachments } = input;

      // Auth: X-Team-ID must map to an active membership.
      const participant = await requireMembership(extra, session_id);
      const teamId = participant.teamId;

      // Reject any type other than "chat" — no system-message spoofing.
      if (type !== undefined && type !== "chat") {
        throw new MCPError(
          "bad_request",
          "agents can only post type=chat",
        );
      }
      const resolvedType = "chat" as const;

      // Reject messages with neither text nor attachments.
      if (!content.text.trim() && (!attachments || attachments.length === 0)) {
        throw new MCPError(
          "bad_request",
          "message must have text or attachments",
        );
      }

      // Guard: total base64 payload must not exceed 3MB.
      const THREE_MB = 3 * 1024 * 1024;
      if (attachments) {
        const totalBytes = attachments.reduce((n, a) => n + a.data.length, 0);
        if (totalBytes > THREE_MB) {
          throw new MCPError(
            "bad_request",
            "attachments exceed 3 MB total limit",
          );
        }
      }

      // Gate: reject writes once the session is closed.
      const session = await getSessionById(session_id);
      if (!session) {
        throw new MCPError("not_found", "Session not found");
      }
      if (session.status === "closed") {
        throw new MCPError("forbidden", "Session is closed");
      }

      // Insert the message; sequence is the cursor for this post.
      const { id: messageId, sequence } = await insertMessage(
        {
          sessionId: session_id,
          postedByTeamId: teamId,
          type: resolvedType,
          content,
        },
        attachments ?? null,
      );

      // Posting counts as activity — touch the heartbeat so last_seen_at stays fresh.
      await touchParticipantHeartbeat(session_id, teamId);

      const result = {
        message_id: messageId,
        cursor: sequence,
        at: new Date().toISOString(),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // wait_for_messages
  // -------------------------------------------------------------------------
  // Long-poll: holds the connection open for up to `timeout` seconds (max 30).
  // Returns immediately when new messages arrive after since_cursor, or when
  // the session is closed, or when the deadline expires (empty result = success).
  //
  // The 500ms poll interval is an MVP simplification. Each loop iteration does
  // a lightweight indexed read (session_id, sequence > ?) on the messages table.
  // TODO: replace with LISTEN/NOTIFY for production to eliminate DB polling overhead.
  server.tool(
    "wait_for_messages",
    waitForMessagesSchema.shape,
    async (
      input: z.infer<typeof waitForMessagesSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, since_cursor } = input;

      // Auth: X-Team-ID must map to an active membership.
      const participant = await requireMembership(extra, session_id);
      const teamId = participant.teamId;

      // Clamp timeout to [1, 30] seconds.
      const rawTimeout = input.timeout ?? 30;
      const timeout = Math.max(1, Math.min(30, rawTimeout));

      // Touch heartbeat FIRST — this call is the primary heartbeat signal for
      // status derivation (active / idle / disconnected in the roster).
      await touchParticipantHeartbeat(session_id, teamId);

      // Lazy sweep: flip stale-active participants before returning messages.
      // Best-effort — a sweep failure must not block the long-poll.
      try {
        await sweepStaleParticipants(session_id);
      } catch (err) {
        console.error("[wait_for_messages] sweep error (ignored):", err);
      }

      const deadline = Date.now() + timeout * 1000;

      // Long-poll loop — server-side, NOT client-driven.
      // Each iteration: query for new messages, check session state, sleep if idle.
      while (true) {
        // Query for messages with sequence > since_cursor, up to 200 at a time.
        const rows = await getMessagesAfter(session_id, since_cursor, 200);

        if (rows.length > 0) {
          // New messages found — return immediately.
          const highestSeq = rows[rows.length - 1]!.sequence;
          const result = {
            messages: rows.map(serializeMessage),
            next_cursor: highestSeq,
            session_closed: false,
          };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result) },
            ],
          };
        }

        // Re-check session status — it may have been concluded mid-poll.
        // If closed, return with session_closed: true and whatever messages
        // are queued (most likely the session_concluded system message).
        const session = await getSessionById(session_id);
        if (session?.status === "closed") {
          // One final read to pick up any last messages (e.g. session_concluded).
          const finalRows = await getMessagesAfter(
            session_id,
            since_cursor,
            200,
          );
          const highestSeq =
            finalRows.length > 0
              ? finalRows[finalRows.length - 1]!.sequence
              : since_cursor;
          const result = {
            messages: finalRows.map(serializeMessage),
            next_cursor: highestSeq,
            session_closed: true,
          };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result) },
            ],
          };
        }

        // Deadline check — if we've run out of time, return empty (not an error).
        if (Date.now() >= deadline) {
          const result = {
            messages: [],
            next_cursor: since_cursor,
            session_closed: false,
          };
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result) },
            ],
          };
        }

        // Sleep before the next iteration.
        // 500ms is a practical trade-off for MVP — short enough to keep latency
        // low, cheap enough to avoid hammering the DB at high agent concurrency.
        await new Promise<void>((r) => setTimeout(r, 500));
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_history
  // -------------------------------------------------------------------------
  // Backwards pagination: each page goes further into the past.
  // If before_cursor is omitted/null, returns the most recent batch.
  // Results are reversed to ascending (chronological) order for UI friendliness —
  // the pagination direction is backwards but each page itself reads naturally.
  server.tool(
    "get_history",
    getHistorySchema.shape,
    async (
      input: z.infer<typeof getHistorySchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id } = input;

      // Auth: X-Team-ID must map to an active membership.
      const participant = await requireMembership(extra, session_id);
      const teamId = participant.teamId;

      // Touch heartbeat — any read counts as activity.
      await touchParticipantHeartbeat(session_id, teamId);

      // Lazy sweep: flip stale-active participants before returning history.
      // Best-effort — a sweep failure must not block the read.
      try {
        await sweepStaleParticipants(session_id);
      } catch (err) {
        console.error("[get_history] sweep error (ignored):", err);
      }

      // Resolve limit: default 100, max 500; values above 500 silently clamp to 100
      // per README ("values above 500 are treated as 100, not rejected").
      const rawLimit = input.limit ?? 100;
      const limit = rawLimit > 500 ? 100 : rawLimit;

      // Resolve before_cursor: if null/undefined, use Number.MAX_SAFE_INTEGER so
      // getMessagesBefore returns the tail of the feed (most recent messages).
      // getMessagesBefore queries: WHERE sequence < beforeCursor ORDER BY sequence DESC
      const beforeCursor = input.before_cursor ?? Number.MAX_SAFE_INTEGER;

      // Fetch messages older than beforeCursor, descending, limited to `limit` rows.
      const rows = await getMessagesBefore(session_id, beforeCursor, limit);

      // has_more heuristic: if we got exactly `limit` rows, there are likely older
      // messages; the final page returns fewer than `limit`.
      const hasMore = rows.length === limit;

      // next_cursor for backwards pagination: lowest sequence in this batch minus 1.
      // Passing this as before_cursor on the next call will continue going back in time.
      // null when has_more is false — the caller has reached the beginning of the feed.
      const nextCursor =
        hasMore && rows.length > 0
          ? rows[rows.length - 1]!.sequence - 1
          : null;

      // Reverse to ascending (chronological) order — getMessagesBefore returns
      // descending; UI rendering is friendlier when messages read earliest-first
      // within each page even though pagination itself walks backwards.
      const ascendingRows = [...rows].reverse();

      const result = {
        messages: ascendingRows.map(serializeMessage),
        next_cursor: nextCursor,
        has_more: hasMore,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
