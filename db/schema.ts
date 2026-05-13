/**
 * db/schema.ts — Drizzle ORM schema for Project Merkle
 *
 * Four tables:
 *   sessions            — one row per collaborative session
 *   participants        — one row per (session, team) pair
 *   messages            — append-only transaction feed
 *   session_doc_history — per-version snapshots of the session document
 *
 * FK policy:
 *   - sessions.id is referenced by participants, messages, and session_doc_history
 *   - fields that logically reference a participant (created_by_team_id,
 *     posted_by_team_id, written_by_team_id) are NOT FK-constrained to
 *     participants because the convener row must exist before the session row,
 *     which references it — a circular ordering problem. These are logical
 *     references validated at the application layer.
 *
 * Sequence strategy for messages.sequence:
 *   bigserial — a single global auto-incrementing sequence. Cursor values are
 *   not contiguous within a session (gaps may appear across sessions), but they
 *   are strictly monotonically increasing. The README requires monotonic ordering
 *   only, not contiguity, so this is correct and simpler than a per-session
 *   application-managed counter.
 *
 * gen_random_uuid():
 *   Drizzle's .defaultRandom() emits gen_random_uuid(), which is built in to
 *   Postgres 13+. No pgcrypto extension line needed in the migration.
 */

import { relations } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Session lifecycle state. */
export const sessionStatusEnum = pgEnum("session_status", [
  "active",
  "closed",
]);

/** Per-participant presence state, derived from last_seen_at. */
export const participantStatusEnum = pgEnum("participant_status", [
  "active",
  "idle",
  "disconnected",
]);

/**
 * Feed message type.
 * "chat" — posted by a team via post_message.
 * "system" — server-generated (team_joined, team_left, session_concluded, etc.).
 * Agents may only post "chat"; any attempt to post a system type returns 400.
 *
 * message.content shape convention:
 *   chat:    { "text": "..." }
 *   system:  { "event": "<event_name>", ...event-specific fields }
 *   e.g.    { "event": "team_joined", "team": "Alex's Team", "at": "<ts>" }
 */
export const messageTypeEnum = pgEnum("message_type", ["chat", "system"]);

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),

  /** Short display label; max 200 chars; set at creation. */
  title: varchar("title", { length: 200 }).notNull(),

  /**
   * Longer-form description of session goals; set at creation.
   * NOT NULL — callers must supply a description (may be an empty string).
   */
  description: text("description").notNull(),

  /**
   * Optional display title for the session document, managed by agents via MCP.
   * Rendered above the markdown body in the Document tab.
   * Independent of sessions.title (the session-level label shown in the dashboard).
   * Null means no explicit doc title has been set.
   */
  sessionDocTitle: varchar("session_doc_title", { length: 255 }),

  /** Live session document content (markdown). Starts empty. */
  sessionDoc: text("session_doc").notNull().default(""),

  /** Increments on every write to sessionDoc. Used for optimistic concurrency. */
  sessionDocVersion: integer("session_doc_version").notNull().default(0),

  /**
   * Convener's team_id. Logical reference only — no FK to participants.
   * See FK policy note at top of file.
   */
  createdByTeamId: uuid("created_by_team_id").notNull(),

  /** Wall-clock creation time. */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),

  /** Set by conclude_session; null while session is active. */
  closedAt: timestamp("closed_at", { withTimezone: true }),

  /** Lifecycle state. Drives post_message / doc-write gating. */
  status: sessionStatusEnum("status").notNull().default("active"),

  /**
   * scrypt hash of the session passcode, format: `${saltHex}:${derivedKeyHex}`.
   * Generated at create_session time; verified on join_session for new joiners.
   * Raw passcode is returned only once (in the create_session response) and
   * never stored in plaintext.
   */
  passcodeHash: text("passcode_hash").notNull(),
});

// ---------------------------------------------------------------------------
// participants
// ---------------------------------------------------------------------------

export const participants = pgTable(
  "participants",
  {
    /** FK → sessions.id. Part of composite PK. */
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),

    /**
     * Session-scoped opaque team identity token.
     * Issued at join_session / create_session time via defaultRandom().
     * Part of composite PK.
     */
    teamId: uuid("team_id").notNull().defaultRandom(),

    /** Human-readable label supplied at join time (e.g. "Alex's Team"). */
    teamName: varchar("team_name", { length: 200 }).notNull(),

    /** Timestamp of the join_session / create_session call. */
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * Updated on every wait_for_messages call from this team.
     * Drives status derivation: active / idle / disconnected.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * Presence state — derived from lastSeenAt, written by server.
     * active:       poll in flight or last poll < ~10 s ago
     * idle:         10–60 s since last poll
     * disconnected: > 60 s since last poll
     */
    status: participantStatusEnum("status").notNull().default("active"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.teamId] })],
);

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** FK → sessions.id. */
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),

    /**
     * Which team posted this message. NULL for server-generated system messages.
     * Logical reference only — no FK to participants.
     * See FK policy note at top of file.
     */
    postedByTeamId: uuid("posted_by_team_id"),

    /** "chat" for agent messages; "system" for server-generated events. */
    type: messageTypeEnum("type").notNull(),

    /**
     * Message payload as JSONB.
     * chat:   { "text": "..." }
     * system: { "event": "<name>", ...fields }
     */
    content: jsonb("content").notNull(),

    /** Wall-clock insert time. */
    postedAt: timestamp("posted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * THE CURSOR — used by wait_for_messages and get_history.
     *
     * Strategy: single global bigserial. The value is not contiguous within a
     * session (a session may have gaps like 1, 3, 7) but it is strictly
     * monotonically increasing. The README requires only monotonic ordering, so
     * gaps are acceptable. Cursor comparisons are plain integer inequalities:
     *   WHERE session_id = ? AND sequence > ?
     *
     * The index on (session_id, sequence) below makes these queries O(log n).
     */
    sequence: bigserial("sequence", { mode: "number" }).notNull(),

    /**
     * Optional image attachments for chat messages.
     * Each entry is an Attachment: { type: 'image', mime: string, data: string }
     * where data is raw base64 (no "data:" URI prefix).
     * Total payload capped at 3MB at the application layer.
     */
    attachments: jsonb("attachments").$type<Attachment[] | null>(),
  },
  (t) => [
    index("messages_session_sequence_idx").on(t.sessionId, t.sequence),
  ],
);

// ---------------------------------------------------------------------------
// session_doc_history
// ---------------------------------------------------------------------------

export const sessionDocHistory = pgTable(
  "session_doc_history",
  {
    /** FK → sessions.id. Part of composite PK. */
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),

    /**
     * Matches sessions.session_doc_version at the moment of the write.
     * Part of composite PK.
     */
    version: integer("version").notNull(),

    /** Full document snapshot at this version. */
    content: text("content").notNull(),

    /**
     * Which team performed the write. Logical reference only — no FK to
     * participants. See FK policy note at top of file.
     */
    writtenByTeamId: uuid("written_by_team_id").notNull(),

    /** Wall-clock write time. */
    writtenAt: timestamp("written_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.version] })],
);

// ---------------------------------------------------------------------------
// Drizzle relations — enable join helpers in queries
// ---------------------------------------------------------------------------

export const sessionsRelations = relations(sessions, ({ many }) => ({
  participants: many(participants),
  messages: many(messages),
  sessionDocHistory: many(sessionDocHistory),
}));

export const participantsRelations = relations(participants, ({ one }) => ({
  session: one(sessions, {
    fields: [participants.sessionId],
    references: [sessions.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, {
    fields: [messages.sessionId],
    references: [sessions.id],
  }),
}));

export const sessionDocHistoryRelations = relations(
  sessionDocHistory,
  ({ one }) => ({
    session: one(sessions, {
      fields: [sessionDocHistory.sessionId],
      references: [sessions.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Inferred TypeScript types — use these throughout the app
// ---------------------------------------------------------------------------

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Participant = typeof participants.$inferSelect;
export type NewParticipant = typeof participants.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type SessionDocHistory = typeof sessionDocHistory.$inferSelect;
export type NewSessionDocHistory = typeof sessionDocHistory.$inferInsert;

/**
 * A single image attachment stored as raw base64 in messages.attachments.
 * `data` is the base64-encoded image bytes with NO "data:..." URI prefix.
 */
export interface Attachment {
  type: 'image';
  mime: string;
  data: string; // raw base64, no "data:" URI prefix
}
