/**
 * Drizzle query helpers for MCP tool implementations.
 *
 * SERVER-ONLY — imports the DB connection which binds to the Node.js postgres driver.
 * Never import this file from client code or client components.
 *
 * All helpers are intentionally thin wrappers: they own the query shape and column
 * references so tool handlers never write raw Drizzle expressions directly.
 */
import "server-only";

import { and, asc, desc, eq, gt, ilike, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/index";
import {
  messages,
  participants,
  sessionDocHistory,
  sessions,
  supportTicketOptions,
  type Attachment,
  type Message,
  type NewMessage,
  type NewParticipant,
  type NewSession,
  type NewSupportTicketOption,
  type Participant,
  type Session,
  type SupportTicketOption,
} from "@/db/schema";
import { MCPError } from "@/lib/mcp/errors";

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Returns the session row for the given id, or null if not found. */
export async function getSessionById(id: string): Promise<Session | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Inserts a new session row and returns it. */
export async function insertSession(values: NewSession): Promise<Session> {
  const rows = await db.insert(sessions).values(values).returning();
  return rows[0]!;
}

/**
 * Returns sessions with an active participant count, filtered by status.
 * Uses a single LEFT JOIN + COUNT grouped query — no N+1.
 * Orders by created_at descending (most recent first).
 *
 * "active" participants = those whose status is NOT 'disconnected' — mirrors
 * the participantStatusEnum values: 'active' | 'idle' | 'disconnected'.
 */
export async function listSessionsWithParticipantCount(options: {
  status: "active" | "closed" | "all";
  limit: number;
}): Promise<
  Array<{
    id: string;
    title: string;
    description: string;
    status: "active" | "closed";
    createdAt: Date;
    participantCount: number;
  }>
> {
  const { status, limit } = options;

  // Build the base query with a LEFT JOIN that counts non-disconnected participants.
  const query = db
    .select({
      id: sessions.id,
      title: sessions.title,
      description: sessions.description,
      status: sessions.status,
      createdAt: sessions.createdAt,
      participantCount:
        sql<number>`COALESCE(COUNT(${participants.teamId}) FILTER (WHERE ${participants.status} != 'disconnected'), 0)::int`,
    })
    .from(sessions)
    .leftJoin(participants, eq(participants.sessionId, sessions.id))
    .groupBy(sessions.id)
    .orderBy(desc(sessions.createdAt))
    .limit(limit);

  // Apply status filter.
  if (status === "active") {
    return query.where(ne(sessions.status, "closed")) as Promise<
      Array<{
        id: string;
        title: string;
        description: string;
        status: "active" | "closed";
        createdAt: Date;
        participantCount: number;
      }>
    >;
  }
  if (status === "closed") {
    return query.where(eq(sessions.status, "closed")) as Promise<
      Array<{
        id: string;
        title: string;
        description: string;
        status: "active" | "closed";
        createdAt: Date;
        participantCount: number;
      }>
    >;
  }
  // "all" — no filter
  return query as Promise<
    Array<{
      id: string;
      title: string;
      description: string;
      status: "active" | "closed";
      createdAt: Date;
      participantCount: number;
    }>
  >;
}

/**
 * Returns sessions matching a case-insensitive substring on title or description,
 * filtered by status and limited to the given count. Same column shape as
 * listSessionsWithParticipantCount. Orders by created_at descending.
 */
export async function searchSessionsWithParticipantCount(options: {
  query: string;
  status: "active" | "closed" | "all";
  limit: number;
}): Promise<
  Array<{
    id: string;
    title: string;
    description: string;
    status: "active" | "closed";
    createdAt: Date;
    participantCount: number;
  }>
> {
  const { query, status, limit } = options;
  const pattern = `%${query}%`;

  const baseQuery = db
    .select({
      id: sessions.id,
      title: sessions.title,
      description: sessions.description,
      status: sessions.status,
      createdAt: sessions.createdAt,
      participantCount:
        sql<number>`COALESCE(COUNT(${participants.teamId}) FILTER (WHERE ${participants.status} != 'disconnected'), 0)::int`,
    })
    .from(sessions)
    .leftJoin(participants, eq(participants.sessionId, sessions.id))
    .groupBy(sessions.id)
    .orderBy(desc(sessions.createdAt))
    .limit(limit);

  const textFilter = or(
    ilike(sessions.title, pattern),
    ilike(sessions.description, pattern),
  )!;

  type ResultRow = {
    id: string;
    title: string;
    description: string;
    status: "active" | "closed";
    createdAt: Date;
    participantCount: number;
  };

  if (status === "active") {
    return baseQuery.where(
      and(ne(sessions.status, "closed"), textFilter),
    ) as Promise<ResultRow[]>;
  }
  if (status === "closed") {
    return baseQuery.where(
      and(eq(sessions.status, "closed"), textFilter),
    ) as Promise<ResultRow[]>;
  }
  // "all" — only text filter
  return baseQuery.where(textFilter) as Promise<ResultRow[]>;
}

/** Sets status = 'closed' and closed_at = NOW on the given session; returns updated row. */
export async function closeSession(sessionId: string): Promise<Session> {
  const rows = await db
    .update(sessions)
    .set({ status: "closed", closedAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .returning();
  const row = rows[0];
  if (!row) throw new MCPError("not_found", "Session not found");
  return row;
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

/** Returns the participant row for (sessionId, teamId), or null if not found. */
export async function getParticipant(
  sessionId: string,
  teamId: string,
): Promise<Participant | null> {
  const rows = await db
    .select()
    .from(participants)
    .where(
      and(
        eq(participants.sessionId, sessionId),
        eq(participants.teamId, teamId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Returns all participant rows for the given session. */
export async function listParticipants(
  sessionId: string,
): Promise<Participant[]> {
  return db
    .select()
    .from(participants)
    .where(eq(participants.sessionId, sessionId));
}

/** Inserts a new participant row and returns it. */
export async function insertParticipant(
  values: NewParticipant,
): Promise<Participant> {
  const rows = await db.insert(participants).values(values).returning();
  return rows[0]!;
}

/** Updates the participant's status field. */
export async function markParticipantStatus(
  sessionId: string,
  teamId: string,
  status: "active" | "idle" | "disconnected",
): Promise<void> {
  await db
    .update(participants)
    .set({ status })
    .where(
      and(
        eq(participants.sessionId, sessionId),
        eq(participants.teamId, teamId),
      ),
    );
}

/** Updates last_seen_at to NOW for the given participant — used as heartbeat. */
export async function touchParticipantHeartbeat(
  sessionId: string,
  teamId: string,
): Promise<void> {
  await db
    .update(participants)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(participants.sessionId, sessionId),
        eq(participants.teamId, teamId),
      ),
    );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Inserts a message row and returns its id and sequence (cursor). */
export async function insertMessage(
  values: Omit<NewMessage, "sequence">,
  attachments?: Attachment[] | null,
): Promise<{ id: string; sequence: number }> {
  const rows = await db
    .insert(messages)
    .values({ ...values, attachments: attachments ?? null })
    .returning({
      id: messages.id,
      sequence: messages.sequence,
    });
  return rows[0]!;
}

/** Returns messages where sequence > sinceCursor, ascending, limited to limit rows. */
export async function getMessagesAfter(
  sessionId: string,
  sinceCursor: number,
  limit: number,
): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        gt(messages.sequence, sinceCursor),
      ),
    )
    .orderBy(messages.sequence)
    .limit(limit);
}

/**
 * Returns messages where sequence < beforeCursor, descending, limited to limit rows.
 * Used by get_history for backwards pagination.
 */
export async function getMessagesBefore(
  sessionId: string,
  beforeCursor: number,
  limit: number,
): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        lt(messages.sequence, beforeCursor),
      ),
    )
    .orderBy(desc(messages.sequence))
    .limit(limit);
}

/** Returns the highest sequence value for the session, or 0 if no messages exist. */
export async function getCurrentEndCursor(sessionId: string): Promise<number> {
  const rows = await db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${messages.sequence}), 0)` })
    .from(messages)
    .where(eq(messages.sessionId, sessionId));
  return rows[0]?.maxSeq ?? 0;
}

// ---------------------------------------------------------------------------
// Session document
// ---------------------------------------------------------------------------

/** Returns the current session doc content, version, and doc title. */
export async function readSessionDoc(
  sessionId: string,
): Promise<{ content: string; version: number; title: string | null }> {
  const rows = await db
    .select({
      content: sessions.sessionDoc,
      version: sessions.sessionDocVersion,
      title: sessions.sessionDocTitle,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!rows[0]) throw new MCPError("not_found", "Session not found");
  return rows[0];
}

/**
 * Full-replace write with optimistic concurrency.
 * Executes UPDATE ... WHERE session_id = ? AND session_doc_version = expectedVersion.
 * Returns the new version on success; throws MCPError('conflict') if the version
 * doesn't match (someone else wrote between the caller's read and write).
 * Also records a history snapshot.
 *
 * title semantics: undefined = leave existing value alone; null = clear it; string = set it.
 */
export async function writeSessionDoc(
  sessionId: string,
  content: string,
  expectedVersion: number,
  writtenByTeamId: string,
  title?: string | null,
): Promise<number> {
  const newVersion = expectedVersion + 1;

  // Build the title update patch only when the caller explicitly provided a value.
  const titlePatch: { sessionDocTitle?: string | null } =
    title !== undefined ? { sessionDocTitle: title } : {};

  const result = await db.transaction(async (tx) => {
    const updated = await tx
      .update(sessions)
      .set({ sessionDoc: content, sessionDocVersion: newVersion, ...titlePatch })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.sessionDocVersion, expectedVersion),
        ),
      )
      .returning({ version: sessions.sessionDocVersion });

    if (!updated[0]) {
      throw new MCPError(
        "conflict",
        "Document version mismatch — re-read and retry",
        { expectedVersion },
      );
    }

    await tx.insert(sessionDocHistory).values({
      sessionId,
      version: newVersion,
      content,
      writtenByTeamId,
    });

    return updated[0].version;
  });

  return result;
}

/**
 * Atomic read+append+write inside a transaction — no version token required from
 * the caller. Returns the new version. Also records a history snapshot.
 *
 * title semantics: undefined = leave existing value alone; null = clear it; string = set it.
 */
export async function appendToSessionDoc(
  sessionId: string,
  text: string,
  writtenByTeamId: string,
  title?: string | null,
): Promise<number> {
  // Build the title update patch only when the caller explicitly provided a value.
  const titlePatch: { sessionDocTitle?: string | null } =
    title !== undefined ? { sessionDocTitle: title } : {};

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        content: sessions.sessionDoc,
        version: sessions.sessionDocVersion,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!rows[0]) throw new MCPError("not_found", "Session not found");

    const { content: current, version } = rows[0];
    const newContent =
      current.length > 0 ? `${current}\n${text}` : text;
    const newVersion = version + 1;

    await tx
      .update(sessions)
      .set({ sessionDoc: newContent, sessionDocVersion: newVersion, ...titlePatch })
      .where(eq(sessions.id, sessionId));

    await tx.insert(sessionDocHistory).values({
      sessionId,
      version: newVersion,
      content: newContent,
      writtenByTeamId,
    });

    return newVersion;
  });
}

/**
 * Inserts a snapshot row into session_doc_history.
 * Called automatically by writeSessionDoc and appendToSessionDoc —
 * tool handlers should NOT call this directly; use those helpers instead.
 */
export async function recordSessionDocHistory(
  sessionId: string,
  version: number,
  content: string,
  writtenByTeamId: string,
): Promise<void> {
  await db.insert(sessionDocHistory).values({
    sessionId,
    version,
    content,
    writtenByTeamId,
  });
}

// ---------------------------------------------------------------------------
// Support sessions
// ---------------------------------------------------------------------------

/**
 * Returns the support-session flag and currently-selected ticket key for the
 * given session, or null if the session does not exist.
 */
export async function getSupportSessionState(
  sessionId: string,
): Promise<{
  isSupportSession: boolean;
  selectedTicketKey: string | null;
} | null> {
  const rows = await db
    .select({
      isSupportSession: sessions.isSupportSession,
      selectedTicketKey: sessions.selectedTicketKey,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Replaces the full set of pushed ticket options for a session in a single
 * transaction: deletes the existing rows, then bulk-inserts the new rows.
 *
 * If the session's previously-selected ticket key is not present in the new
 * rows, also clears sessions.selected_ticket_key in the same transaction. The
 * caller is expected to broadcast a support_ticket_selected event with
 * ticket_key=null when clearedSelection is true.
 *
 * Passing an empty rows array is allowed — it deletes all options and (when
 * appropriate) clears the selection; returns count=0.
 */
export async function replaceSupportTicketOptions(
  sessionId: string,
  rows: NewSupportTicketOption[],
): Promise<{
  count: number;
  clearedSelection: boolean;
  previousSelection: string | null;
}> {
  return db.transaction(async (tx) => {
    // Read current selection up front so we can decide whether to clear it.
    const sessionRows = await tx
      .select({ selectedTicketKey: sessions.selectedTicketKey })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!sessionRows[0]) {
      throw new MCPError("not_found", "Session not found");
    }
    const previousSelection = sessionRows[0].selectedTicketKey;

    // Truncate-and-insert the option set for this session only.
    await tx
      .delete(supportTicketOptions)
      .where(eq(supportTicketOptions.sessionId, sessionId));

    if (rows.length > 0) {
      // Force the sessionId on every row to guard against caller mismatch.
      await tx
        .insert(supportTicketOptions)
        .values(rows.map((r) => ({ ...r, sessionId })));
    }

    // If the prior selection is no longer in the option set, null it out.
    const newKeys = rows.map((r) => r.ticketKey);
    const clearedSelection =
      previousSelection !== null && !newKeys.includes(previousSelection);

    if (clearedSelection) {
      await tx
        .update(sessions)
        .set({ selectedTicketKey: null })
        .where(eq(sessions.id, sessionId));
    }

    return {
      count: rows.length,
      clearedSelection,
      previousSelection,
    };
  });
}

/**
 * Returns all pushed ticket options for the session ordered by project ASC,
 * number ASC. Empty array if none exist.
 */
export async function listSupportTicketOptions(
  sessionId: string,
): Promise<SupportTicketOption[]> {
  return db
    .select()
    .from(supportTicketOptions)
    .where(eq(supportTicketOptions.sessionId, sessionId))
    .orderBy(asc(supportTicketOptions.project), asc(supportTicketOptions.number));
}

/**
 * Returns the single support_ticket_options row matching (sessionId, ticketKey),
 * or null if no such row exists. Used to validate selections before mirroring
 * to sessions.selected_ticket_key.
 */
export async function findSupportTicketOption(
  sessionId: string,
  ticketKey: string,
): Promise<SupportTicketOption | null> {
  const rows = await db
    .select()
    .from(supportTicketOptions)
    .where(
      and(
        eq(supportTicketOptions.sessionId, sessionId),
        eq(supportTicketOptions.ticketKey, ticketKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Sets (or clears) sessions.selected_ticket_key for the given session. When
 * ticketKey is non-null, validates that it exists in support_ticket_options
 * for this session and throws MCPError('not_found') otherwise. Returns the
 * previous and new values for use in event payloads.
 *
 * _byTeamId is reserved for future audit logging — accepted but not used yet.
 */
export async function setSelectedSupportTicket(
  sessionId: string,
  ticketKey: string | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _byTeamId: string,
): Promise<{ previousKey: string | null; newKey: string | null }> {
  return db.transaction(async (tx) => {
    const sessionRows = await tx
      .select({ selectedTicketKey: sessions.selectedTicketKey })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!sessionRows[0]) {
      throw new MCPError("not_found", "Session not found");
    }
    const previousKey = sessionRows[0].selectedTicketKey;

    if (ticketKey !== null) {
      const optionRows = await tx
        .select({ ticketKey: supportTicketOptions.ticketKey })
        .from(supportTicketOptions)
        .where(
          and(
            eq(supportTicketOptions.sessionId, sessionId),
            eq(supportTicketOptions.ticketKey, ticketKey),
          ),
        )
        .limit(1);
      if (!optionRows[0]) {
        throw new MCPError(
          "not_found",
          "Ticket key not in this session's pushed options",
          { ticketKey },
        );
      }
    }

    await tx
      .update(sessions)
      .set({ selectedTicketKey: ticketKey })
      .where(eq(sessions.id, sessionId));

    return { previousKey, newKey: ticketKey };
  });
}
