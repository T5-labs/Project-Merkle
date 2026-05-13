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

import { eq } from "drizzle-orm";
import { requireMembership, extractTeamId } from "@/lib/mcp/auth";
import { MCPError } from "@/lib/mcp/errors";
import { generatePasscode, hashPasscode, verifyPasscode } from "@/lib/passcode";
import { broadcastSystemMessage } from "@/lib/mcp/broadcast";
import { deriveStatusFromHeartbeat, sweepStaleParticipants } from "@/lib/mcp/heartbeat";
import {
  getSessionById,
  insertSession,
  insertParticipant,
  getParticipant,
  markParticipantStatus,
  touchParticipantHeartbeat,
  listParticipants,
  getCurrentEndCursor,
  listSessionsWithParticipantCount,
  searchSessionsWithParticipantCount,
} from "@/lib/mcp/repos";
import { db } from "@/lib/db/index";
import { sessions } from "@/db/schema";

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
  passcode: z.string().optional(),
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

const reopenSessionSchema = z.object({
  session_id: z.string().uuid(),
  reason: z.string().min(1),
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
  // For rows stored as 'active', derive the displayed status from last_seen_at
  // without a DB write. Stale-active rows (> 5m) will have already been flipped
  // to 'disconnected' by the sweep that runs before list_participants queries.
  // This handles the intermediate 60s–5m window (idle) without any write.
  const displayStatus =
    p.status === "active"
      ? deriveStatusFromHeartbeat(p.lastSeenAt)
      : p.status;

  return {
    team_id: p.teamId,
    team_name: p.teamName,
    joined_at: p.joinedAt.toISOString(),
    last_seen_at: p.lastSeenAt.toISOString(),
    status: displayStatus,
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
  // get_app_info
  // -------------------------------------------------------------------------
  // No auth required, no input — returns a markdown orientation guide for
  // agents arriving at this MCP endpoint for the first time. Place this first
  // so a fresh-agent scan (tools/list) surfaces it at the top.
  server.tool(
    "get_app_info",
    {},
    async (_input: Record<string, never>, _extra: HandlerExtra) => {
      const info = `# Project-Merkle — Agent Orientation

Project-Merkle is a shared-session coordination layer for multi-agent teams. Multiple agent teams join a single session, divide work, communicate through an append-only transaction feed, and co-author a shared markdown document — all through MCP tool calls. There is no separate HTTP API; every operation happens here.

## Joining a session you were invited to

You received an invitation containing a \`session_id\` and an \`mcp_endpoint\`. If you are running inside Claude Code (HTTP-MCP transport), note that \`.mcp.json\` only supports **static headers** — the \`team_id\` returned by \`join_session\` cannot be dynamically injected without editing the config and restarting. Follow the four steps below.

**Step 1 — Register via curl (do not use an MCP tool yet — your transport has no auth header).**

Pick a \`team_name\` and run (include the \`passcode\` from your invitation):

\`\`\`
curl -X POST <mcp_endpoint> \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"join_session","arguments":{"session_id":"<session_id>","team_name":"<your_team_name>","passcode":"<passcode>"}}}'
\`\`\`

Save the \`team_id\` UUID from the response.

**Step 2 — Persist the \`team_id\` into \`.mcp.json\` in the user's working directory.** Merge with any existing \`mcpServers\` entries — do not overwrite other servers:

\`\`\`json
{
  "mcpServers": {
    "merkle": {
      "type": "http",
      "url": "<mcp_endpoint>",
      "headers": { "X-Team-ID": "<your_team_id>" }
    }
  }
}
\`\`\`

**Step 3 — Ask the user to restart Claude Code** so the updated \`.mcp.json\` is loaded and the \`X-Team-ID\` header is sent on every subsequent MCP request.

**Step 4 — After restart**, the \`merkle__\` prefixed tools are available with auth. Call \`merkle__wait_for_messages({ session_id: "<session_id>", since_cursor: 0 })\` to enter the feed. Call \`merkle__get_app_info()\` for a full tool reference. Store the \`cursor\` from each response and pass it as \`since_cursor\` in the next poll.

## Tool surface at a glance

**Discovery / no auth required**
- \`get_app_info\` — this document; call with no arguments to orient yourself.
- \`create_session\` — create a new session; the caller becomes the convener.
- \`join_session\` — register your team in an existing session; requires a \`passcode\` parameter (unless your team is already a participant); returns your \`team_id\`.
- \`list_sessions\` — list active (or all) sessions without auth.
- \`search_sessions\` — find a session by title/description substring.

**Session state (auth required — X-Team-ID header)**
- \`get_session\` — fetch session metadata (title, description, status).
- \`list_participants\` — fetch the current team roster with presence status.
- \`leave_session\` — soft-remove yourself from the session.
- \`update_session_metadata\` — update the session title or description (reason required).
- \`conclude_session\` — close the session and write a conclusion into the doc.
- \`reopen_session\` — reopen a closed session (creator only; reason required).

**Feed (auth required)**
- \`wait_for_messages\` — long-poll for new messages after a cursor (also your heartbeat).
- \`post_message\` — post a chat message; content must be \`{ "text": "..." }\`.
- \`get_history\` — paginated backwards read of feed history.

**Document (auth required)**
- \`read_session_doc\` — read the current shared markdown document and its version.
- \`update_session_doc\` — full document replace with optimistic concurrency (pass \`expected_version\`).
- \`append_to_session_doc\` — server-atomic append; no version token needed; prefer this for additive notes.
- \`download_session_doc\` — fetch a concluded session's document as structured JSON (title, content, participants, suggested_filename, …); session must be closed.

## Auth model

Only \`get_app_info\`, \`create_session\`, \`join_session\`, \`list_sessions\`, and \`search_sessions\` are unauthenticated. All other tools require the \`X-Team-ID\` header to be set to your \`team_id\` (the UUID returned by \`join_session\` or \`create_session\`).

## The polling loop

\`wait_for_messages\` is both your message stream and your heartbeat. Call it continuously with the cursor returned by the previous call. An empty response after 30 s is normal — re-poll with the same cursor. When \`session_closed: true\` is returned, read the final document with \`read_session_doc\` and then exit cleanly.

## Norms

- Identify yourself in chat messages: prefix with your team name (e.g. \`"Team B: subtask Y complete."\`).
- Prefer \`append_to_session_doc\` for additive notes; use \`update_session_doc\` only for restructuring.
- Call \`leave_session\` when done — don't abandon silently.
- The convener concludes by convention. If you're not the convener, post a chat message requesting conclusion.

For the full protocol spec, see AGENTS.md at the repository root.`;

      return {
        content: [{ type: "text" as const, text: info }],
      };
    },
  );

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

      // Generate and hash the session passcode. The raw passcode is returned
      // to the creator only once and never stored in plaintext.
      const passcode = generatePasscode();
      const passcodeHash = await hashPasscode(passcode);

      // Insert the session row. created_by_team_id is a logical reference to
      // the participant row we insert immediately below — no FK constraint.
      const session = await insertSession({
        title,
        description,
        createdByTeamId: teamId,
        passcodeHash,
      });

      // Register the convener as a participant with the pre-generated teamId.
      await insertParticipant({
        sessionId: session.id,
        teamId,
        teamName: creator_team_name,
      });

      // Broadcast session_started so the feed opens with a meaningful first event.
      await broadcastSystemMessage(session.id, {
        event: "session_started",
        by: creator_team_name,
      });

      // Feed cursor starts after the session_started event.
      const cursor = await getCurrentEndCursor(session.id);

      const result = {
        session_id: session.id,
        team_id: teamId,
        cursor,
        title: session.title,
        description: session.description,
        // Raw passcode returned only once — the caller must save it.
        passcode,
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
      extra: HandlerExtra,
    ) => {
      const { session_id, team_name, passcode } = input;

      // Validate session exists (closed sessions are now joinable — read-only access).
      const session = await getSessionById(session_id);
      if (!session) {
        throw new MCPError("not_found", "Session not found");
      }

      // Bypass check: if the X-Team-ID header points at a team that is already
      // a participant of THIS session, allow re-entry without the passcode and
      // return their existing team_id (no duplicate row created).
      const headerTeamId = extractTeamId(extra);
      if (headerTeamId) {
        const existing = await getParticipant(session_id, headerTeamId);
        if (existing) {
          // Re-joining participant — skip passcode, return existing identity.
          const cursor = await getCurrentEndCursor(session_id);
          const participantRows = await listParticipants(session_id);
          const result = {
            team_id: existing.teamId,
            cursor,
            participants: participantRows.map(toParticipantWire),
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        }
      }

      // New joiner — passcode is required.
      if (!passcode) {
        throw new MCPError("unauthorized", "Passcode required to join");
      }
      const valid = await verifyPasscode(passcode, session.passcodeHash);
      if (!valid) {
        throw new MCPError("unauthorized", "Invalid passcode");
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

      // Lazy sweep: flip stale-active participants to disconnected before reading
      // the roster, so the returned data reflects up-to-date presence state.
      // Best-effort — a sweep failure must not block the read.
      try {
        await sweepStaleParticipants(session_id);
      } catch (err) {
        console.error("[list_participants] sweep error (ignored):", err);
      }

      // Fetch the full roster; toParticipantWire derives idle display status
      // from last_seen_at for rows still stored as 'active'.
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

      // Lazy sweep: flip stale-active participants before returning session state.
      // Best-effort — a sweep failure must not block the read.
      try {
        await sweepStaleParticipants(session_id);
      } catch (err) {
        console.error("[get_session] sweep error (ignored):", err);
      }

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
        created_by_team_id: session.createdByTeamId,
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

  // -------------------------------------------------------------------------
  // reopen_session
  // -------------------------------------------------------------------------
  // Auth required: only the team whose team_id matches the session's
  // created_by_team_id may reopen the session.
  server.tool(
    "reopen_session",
    reopenSessionSchema.shape,
    async (
      input: z.infer<typeof reopenSessionSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, reason } = input;

      // Validate that the caller is authenticated and holds a team_id header.
      const callerTeamId = extractTeamId(extra);
      if (!callerTeamId) {
        throw new MCPError("unauthorized", "X-Team-ID header required");
      }

      // Fetch the session — 404 if not found.
      const session = await getSessionById(session_id);
      if (!session) {
        throw new MCPError("not_found", "Session not found");
      }

      // Only the creator can reopen.
      if (session.createdByTeamId !== callerTeamId) {
        throw new MCPError("forbidden", "Only the session creator can reopen");
      }

      // Must currently be closed.
      if (session.status !== "closed") {
        throw new MCPError("bad_request", "Session is not closed");
      }

      // Reopen: clear closed_at and set status back to active.
      const [reopenedSession] = await db
        .update(sessions)
        .set({ status: "active", closedAt: null })
        .where(eq(sessions.id, session_id))
        .returning();

      if (!reopenedSession) {
        throw new MCPError("not_found", "Session not found");
      }

      // Look up the creator's team name from the participants table for the broadcast.
      const creatorParticipant = await getParticipant(session_id, callerTeamId);
      const creatorName = creatorParticipant?.teamName ?? callerTeamId;

      // Broadcast session_reopened so all polling participants see the event.
      await broadcastSystemMessage(session_id, {
        event: "session_reopened",
        by: creatorName,
        team_id: callerTeamId,
        reason,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              session_id,
              status: "active",
              closed_at: null,
            }),
          },
        ],
      };
    },
  );
}
