/**
 * MCP tool implementations for session lifecycle and participant management.
 *
 * Tools:
 *   create_session      — create a new session; convener auto-joins
 *   join_session        — register a team in an existing session
 *   leave_session       — soft-remove a team from a session (auth required)
 *   list_participants   — fetch the current roster (auth required)
 *   get_session         — fetch session metadata (auth required)
 *   list_sessions       — list sessions by status for dashboard view (no auth)
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
import { broadcastSystemMessage } from "@/lib/mcp/broadcast";
import {
  getSessionById,
  insertSession,
  insertParticipant,
  markParticipantStatus,
  touchParticipantHeartbeat,
  listParticipants,
  getCurrentEndCursor,
  listSessionsWithParticipantCount,
  searchSessionsWithParticipantCount,
} from "@/lib/mcp/repos";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const createSessionSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string(),
  creator_team_name: z.string().min(1).max(200),
});

const joinSessionSchema = z.object({
  session_id: z.string().uuid(),
  team_name: z.string().min(1).max(200),
});

const leaveSessionSchema = z.object({
  session_id: z.string().uuid(),
  team_id: z.string().uuid(),
});

const listParticipantsSchema = z.object({
  session_id: z.string().uuid(),
});

const getSessionSchema = z.object({
  session_id: z.string().uuid(),
});

const listSessionsSchema = z.object({
  status: z.enum(["active", "closed", "all"]).optional().default("active"),
  limit: z.number().int().min(1).max(100).optional().default(50),
});

const searchSessionsSchema = z.object({
  query: z.string().min(1),
  status: z.enum(["active", "closed", "all"]).optional().default("active"),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

// Shorthand alias matching what the SDK actually passes into tool callbacks.
type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// ---------------------------------------------------------------------------
// Wire-format helpers
// ---------------------------------------------------------------------------

/**
 * Maps a Drizzle Participant row (camelCase JS keys) to the snake_case wire
 * shape that client-side ParticipantRow types expect.
 *
 * Drizzle stores results under the JS property names defined in the schema
 * (teamId, teamName, joinedAt, lastSeenAt) — not the DB column names — so
 * JSON.stringify(row) produces camelCase keys. The client ParticipantRow
 * interface expects snake_case (team_id, team_name, joined_at, last_seen_at).
 * Without this mapping every p.team_id on the client is undefined, which is
 * the root cause of the React key prop warning in RosterPanel.
 */
function toParticipantWire(p: {
  teamId: string;
  teamName: string;
  joinedAt: Date;
  lastSeenAt: Date;
  status: "active" | "idle" | "disconnected";
}) {
  return {
    team_id: p.teamId,
    team_name: p.teamName,
    joined_at: p.joinedAt.toISOString(),
    last_seen_at: p.lastSeenAt.toISOString(),
    status: p.status,
  };
}

/**
 * Maps a session row + participant count (camelCase Drizzle output) to the
 * snake_case wire shape expected by the client SessionSummary interface.
 */
function toSessionSummaryWire(row: {
  id: string;
  title: string;
  description: string;
  status: "active" | "closed";
  createdAt: Date;
  participantCount: number;
}) {
  return {
    session_id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    participant_count: row.participantCount,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSessionTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // create_session
  // -------------------------------------------------------------------------
  // No auth required — this is the entry point for the convener.
  // We do NOT broadcast a team_joined system message for the convener here.
  // By convention, the create event itself is the convener joining; the feed
  // starts truly empty so joining agents see no noise before the first real
  // message. (The join event is only broadcast for subsequent join_session calls.)
  server.tool(
    "create_session",
    createSessionSchema.shape,
    async (
      input: z.infer<typeof createSessionSchema>,
      _extra: HandlerExtra,
    ) => {
      const { title, description, creator_team_name } = input;

      // Generate the convener's team_id up front so we can set
      // created_by_team_id on the session row in the same step.
      const teamId = crypto.randomUUID();

      // Insert the session row. created_by_team_id is a logical reference to
      // the participant row we insert immediately below — no FK constraint.
      const session = await insertSession({
        title,
        description,
        createdByTeamId: teamId,
      });

      // Register the convener as a participant with the pre-generated teamId.
      await insertParticipant({
        sessionId: session.id,
        teamId,
        teamName: creator_team_name,
      });

      // Feed is empty at creation time; cursor 0 is the correct starting state.
      const cursor = 0;

      const result = {
        session_id: session.id,
        team_id: teamId,
        cursor,
        title: session.title,
        description: session.description,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // join_session
  // -------------------------------------------------------------------------
  // No auth required — this is how a team receives their team_id.
  // A team that re-joins gets a new team_id each time; no idempotency check
  // on team_name is performed (by design — see README Auth flow).
  server.tool(
    "join_session",
    joinSessionSchema.shape,
    async (
      input: z.infer<typeof joinSessionSchema>,
      _extra: HandlerExtra,
    ) => {
      const { session_id, team_name } = input;

      // Validate session exists and is active.
      const session = await getSessionById(session_id);
      if (!session) {
        throw new MCPError("not_found", "Session not found");
      }
      if (session.status === "closed") {
        throw new MCPError("forbidden", "Session is closed");
      }

      // Issue a fresh team_id for this joining team.
      const teamId = crypto.randomUUID();

      // Capture the current end cursor BEFORE inserting the participant row
      // and BEFORE broadcasting the team_joined event. This ensures the joiner
      // starts watching from the moment just before their join was processed.
      // Their first wait_for_messages call will return the team_joined broadcast
      // below — which confirms join visibility to the joining team.
      const cursor = await getCurrentEndCursor(session_id);

      // Register the team.
      await insertParticipant({
        sessionId: session_id,
        teamId,
        teamName: team_name,
      });

      // Snapshot the roster so the joiner knows who else is present.
      const participantRows = await listParticipants(session_id);

      // Broadcast the join event into the feed. This inserts AFTER our cursor
      // was captured, so the joiner will see this event on their first
      // wait_for_messages call — the intended behavior per the spec.
      await broadcastSystemMessage(session_id, {
        event: "team_joined",
        team: team_name,
      });

      const result = {
        team_id: teamId,
        cursor,
        participants: participantRows.map(toParticipantWire),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // leave_session
  // -------------------------------------------------------------------------
  // Auth required: the caller must supply a valid X-Team-ID header that maps
  // to an active membership in this session. A team can only leave itself —
  // the supplied team_id in the body must match the authenticated team's id.
  // The participant row is NOT deleted; soft removal preserves the join/leave
  // timeline in the roster table (per README).
  server.tool(
    "leave_session",
    leaveSessionSchema.shape,
    async (
      input: z.infer<typeof leaveSessionSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, team_id } = input;

      // Validate the X-Team-ID header and confirm active membership.
      const participant = await requireMembership(extra, session_id);

      // A team may only remove itself — prevent one team from kicking another.
      if (participant.teamId !== team_id) {
        throw new MCPError(
          "forbidden",
          "You may only leave a session using your own team_id",
        );
      }

      // Soft-remove: mark as disconnected without deleting the row.
      await markParticipantStatus(session_id, team_id, "disconnected");

      // Broadcast the leave event to all polling teams.
      await broadcastSystemMessage(session_id, {
        event: "team_left",
        team: participant.teamName,
      });

      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ok: true }) },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // list_participants
  // -------------------------------------------------------------------------
  // Auth required. Touching the heartbeat here keeps the team's last_seen_at
  // fresh and implicitly marks them active. Status decay logic (active → idle
  // → disconnected based on poll timestamps) lives in Phase 3c's
  // wait_for_messages heartbeat path; here we just return the stored status.
  server.tool(
    "list_participants",
    listParticipantsSchema.shape,
    async (
      input: z.infer<typeof listParticipantsSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id } = input;

      // Validate membership and get the caller's participant row.
      const callerParticipant = await requireMembership(extra, session_id);

      // Touch heartbeat to record that this team is still active.
      await touchParticipantHeartbeat(session_id, callerParticipant.teamId);

      // Fetch the full roster with stored status fields — do NOT recompute
      // idle/disconnected on the fly here. Status decay lives in Phase 3c.
      const participantRows = await listParticipants(session_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ participants: participantRows.map(toParticipantWire) }),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // get_session
  // -------------------------------------------------------------------------
  // Auth required. Returns the session's metadata fields so joiners and users
  // refreshing the page can bootstrap title/description/status without a
  // separate query path. Touch heartbeat to keep the caller marked active.
  server.tool(
    "get_session",
    getSessionSchema.shape,
    async (
      input: z.infer<typeof getSessionSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id } = input;

      // Validate membership — only session members may read metadata.
      const callerParticipant = await requireMembership(extra, session_id);

      // Touch heartbeat to record that this team is still active.
      await touchParticipantHeartbeat(session_id, callerParticipant.teamId);

      // Read the session row.
      const session = await getSessionById(session_id);
      if (!session) {
        throw new MCPError("not_found", "Session not found");
      }

      const result = {
        session_id: session.id,
        title: session.title,
        description: session.description,
        status: session.status,
        created_at: session.createdAt.toISOString(),
        closed_at: session.closedAt ? session.closedAt.toISOString() : null,
        session_doc_version: session.sessionDocVersion,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // list_sessions
  // -------------------------------------------------------------------------
  // No auth required — dashboard-level read, intentionally open so the home
  // page can show all active sessions without the user holding a team_id.
  server.tool(
    "list_sessions",
    listSessionsSchema.shape,
    async (
      input: z.infer<typeof listSessionsSchema>,
      _extra: HandlerExtra,
    ) => {
      const { status, limit } = input;

      const rows = await listSessionsWithParticipantCount({ status, limit });

      const result = rows.map(toSessionSummaryWire);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // search_sessions
  // -------------------------------------------------------------------------
  // No auth required — same access level as list_sessions. Use when an agent
  // needs to find a specific session by name or description fragment to join,
  // rather than paginating through the full list.
  server.tool(
    "search_sessions",
    searchSessionsSchema.shape,
    async (
      input: z.infer<typeof searchSessionsSchema>,
      _extra: HandlerExtra,
    ) => {
      const { query, status, limit } = input;

      const rows = await searchSessionsWithParticipantCount({ query, status, limit });

      const result = rows.map(toSessionSummaryWire);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
