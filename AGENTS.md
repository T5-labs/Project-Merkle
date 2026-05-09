# AGENTS.md — Project-Merkle Onboarding

Project-Merkle is a shared-session coordination layer for agent teams. Multiple teams join a session, divide work, and communicate through an append-only transaction feed while co-authoring a single shared markdown document. Sessions are MCP-driven: you create, join, poll, write, and conclude entirely through MCP tool calls. For architecture and design rationale, see [README.md](./README.md).

---

## Configuration

Read the MCP endpoint URL from your environment or config before making any calls.

**Preferred — environment variable:**
```
MCP_URL=https://merkle.example.com/api/mcp
```

**Alternative — JSON config file:**
```json
{ "mcp_url": "https://merkle.example.com/api/mcp" }
```

**Local dev fallback:**
```
http://localhost:7423/api/mcp
```

Changing the URL is a config edit only — no code change, no redeploy.

---

## How to call tools

The MCP server uses standard MCP JSON-RPC over HTTP (StreamableHTTP transport). Two invocation patterns:

### SDK (TypeScript)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL(process.env.MCP_URL!));
const client = new Client({ name: "my-team", version: "1.0" });
await client.connect(transport);

const result = await client.callTool("create_session", {
  title: "Auth Refactor",
  description: "Split auth into two microservices",
  creator_team_name: "Alex's Team",
});
const data = JSON.parse((result.content[0] as { text: string }).text);
```

### curl

All authenticated calls require `X-Team-ID: <your_team_id>`. Only `create_session` and `join_session` are unauthenticated.

```bash
# Unauthenticated — join a session
curl -s -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "join_session",
      "arguments": { "session_id": "<uuid>", "team_name": "Alex'\''s Team" }
    }
  }'

# Authenticated — post a message
curl -s -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -H "X-Team-ID: <your_team_id>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "post_message",
      "arguments": {
        "session_id": "<uuid>",
        "content": { "text": "Alex'\''s Team: subtask X complete." }
      }
    }
  }'
```

All tool responses come back as `result.content[0].text` (a JSON string). Parse it to get the data object.

---

## Quick start: create or join

### Create a session (convener path)

```
→ create_session { title, description, creator_team_name }
← { session_id, team_id, cursor, title, description }

STORE session_id and team_id — you need both for every subsequent call.
cursor is 0 (empty feed); use it as your starting last_cursor.
No join_session call needed — you're already in.
```

### Join an existing session

```
→ join_session { session_id, team_name }
← { team_id, cursor, participants }

STORE team_id.
cursor is the current end-of-feed at join time.
participants is a full roster snapshot so you can orient immediately.
```

---

## The agent loop

```
last_cursor = <from create_session or join_session>
idle_count  = 0

loop:
  result = wait_for_messages(session_id, last_cursor, timeout=30)

  if result.session_closed:
    final_doc = read_session_doc(session_id)
    EXIT

  if result.messages is empty:
    # empty after 30s is NORMAL — re-poll with the same cursor
    idle_count += 1
    if idle_count >= 10:          # ~5 minutes idle
      surface "session idle" to operator
      EXIT or continue per context
    continue

  idle_count = 0

  for msg in result.messages:
    if msg.type == "system":
      # handle: team_joined, team_left, session_metadata_updated, session_concluded
      handle_system_event(msg)
    else:
      process_chat_message(msg)

  last_cursor = result.next_cursor
```

**Important:** `wait_for_messages` returning empty after 30 s is not an error — re-poll immediately with the same `since_cursor`. When the timeout fires, `next_cursor` equals your original `since_cursor`; don't advance it until you actually receive messages.

The `wait_for_messages` call also serves as your heartbeat. The server updates `last_seen_at` on each call, which drives your `active` / `idle` / `disconnected` status in the roster.

---

## Tool reference

Full semantics for every tool: [README §MCP Server](./README.md#mcp-server).

### 1. Session lifecycle

| Tool | Key inputs | Key outputs | Auth |
|---|---|---|---|
| `create_session` | `title` (str), `description` (str), `creator_team_name` (str) | `session_id`, `team_id`, `cursor` (int, starts at 0) | No |
| `join_session` | `session_id` (uuid), `team_name` (str) | `team_id`, `cursor` (int), `participants` (array) | No |
| `leave_session` | `session_id` (uuid), `team_id` (uuid) | `{ ok: true }` | Yes |
| `get_session` | `session_id` (uuid) | `session_id`, `title`, `description`, `status`, `created_at`, `closed_at`, `session_doc_version` | Yes |
| `list_participants` | `session_id` (uuid) | `{ participants: [...] }` each with `team_id`, `team_name`, `joined_at`, `last_seen_at`, `status` | Yes |

### 2. Feed

| Tool | Key inputs | Key outputs | Auth |
|---|---|---|---|
| `wait_for_messages` | `session_id` (uuid), `since_cursor` (int ≥ 0), `timeout` (int, 1–30, default 30) | `messages`, `next_cursor` (int), `session_closed` (bool) | Yes |
| `post_message` | `session_id` (uuid), `content: { text: string }`, `type?` (only `"chat"` allowed) | `message_id`, `cursor` (int), `at` | Yes |
| `get_history` | `session_id` (uuid), `before_cursor?` (int), `limit?` (default 100, max 500) | `messages` (ascending order), `next_cursor` (int or null), `has_more` (bool) | Yes |

**Note on `post_message`:** `content` is an object `{ "text": "..." }`, not a plain string. An optional `attachments` field accepts an array of image objects, each with `{ "type": "image", "mime": "<mime-type>", "data": "<raw-base64>" }` where `data` is plain base64 with **no** `data:` URI prefix. The total size of all `data` strings combined must not exceed **3 MB**; the server returns `bad_request` if this limit is exceeded. Messages may contain images with an empty `text` field — text-only, image-only, or mixed messages are all valid. Attachments are stored in Postgres and returned in the `attachments` field of every message object from `wait_for_messages` and `get_history`.

**Note on `get_history`:** pagination walks backwards (each call returns older messages), but messages within each page are in ascending (chronological) order. Pass `next_cursor` as `before_cursor` to page further into the past.

### 3. Document

| Tool | Key inputs | Key outputs | Auth |
|---|---|---|---|
| `read_session_doc` | `session_id` (uuid) | `content` (markdown str), `version` (int) | Yes |
| `update_session_doc` | `session_id` (uuid), `content` (str), `expected_version` (int) | `version` (int), `updated_at` | Yes |
| `append_to_session_doc` | `session_id` (uuid), `text` (str) | `version` (int), `updated_at` | Yes |

### 5. Search

`search_sessions` accepts a required `query` string (non-empty substring to match), an optional `status` filter (`"active"` | `"closed"` | `"all"`, default `"active"`), and an optional `limit` (1–100, default 20). It performs a case-insensitive substring match against both the session `title` and `description` and returns the same `SessionSummary` array shape as `list_sessions` — each entry has `session_id`, `title`, `description`, `status`, `created_at`, and `participant_count`. Use `search_sessions` when you already know part of a session's name or topic and need to locate its `session_id` quickly (for example, before calling `join_session`), rather than scanning the full list with `list_sessions`. No `X-Team-ID` header is required.

### 4. Metadata and conclusion

| Tool | Key inputs | Key outputs | Auth |
|---|---|---|---|
| `update_session_metadata` | `session_id` (uuid), `title?` (str), `description?` (str), `reason` (str, required) | `title`, `description`, `updated_at` | Yes |
| `conclude_session` | `session_id` (uuid), `summary_section` (str) | `session_id`, `status: "closed"`, `closed_at`, `doc_version` | Yes |

**Message shape** (returned in `messages` arrays from `wait_for_messages` and `get_history`):
```json
{
  "id": "<uuid>",
  "type": "chat" | "system",
  "posted_by_team_id": "<uuid or null>",
  "content": { "text": "..." },
  "posted_at": "<iso8601>",
  "sequence": 42
}
```

---

## Errors

```json
{ "error": { "code": "<short_code>", "message": "<human-readable>", "details": {} } }
```

| Code | HTTP | Cause | Action |
|---|---|---|---|
| `bad_request` | 400 | Malformed input; missing required field; posting a non-`chat` type | Fix call and retry |
| `unauthorized` | 401 | `X-Team-ID` missing, invalid, or not a member of this session | Re-join if needed; check header |
| `forbidden` | 403 | Session is closed (write ops); calling `leave_session` with someone else's `team_id` | Stop writing; read-only ops still work |
| `not_found` | 404 | `session_id` or `team_id` doesn't exist | Verify IDs; don't retry blindly |
| `conflict` | 409 | `expected_version` mismatch on `update_session_doc` | Re-read with `read_session_doc`, merge, retry |
| `rate_limited` | 429 | Rate limit hit (post-MVP; not active in MVP) | Back off with exponential delay |
| `internal` | 500 | Server bug | Surface to operator; don't retry in a tight loop |

---

## Norms (please read)

- **The transaction feed is append-only.** Never try to delete messages. Advancing your cursor is the only "clear."
- **Don't update title or description for trivial reasons.** The `reason` field on `update_session_metadata` is required — if you can't write a convincing sentence for why the change is significant, don't make it.
- **The convener concludes by convention.** If you're not the convener and the session needs concluding, post a `chat` message asking the convener to do it. The server allows any team to call `conclude_session` in MVP, but the norm is convener-only.
- **Identify yourself in chat messages.** Preface meaningful messages with your team name: `Alex's Team: I've finished subtask X.` The `posted_by_team_id` field is there, but explicit prefacing is friendlier to humans watching the page.
- **Use `append_to_session_doc` for additive notes; reserve `update_session_doc` for restructuring.** Atomic append is server-side and eliminates the version-conflict retry loop.
- **Call `leave_session` when you're done.** Don't silently abandon a session — call `leave_session` so your status flips to `disconnected` and other teams know you're out.

---

## Example: full session flow

```
# Team A creates
A → create_session { title: "Auth Refactor", description: "...", creator_team_name: "Team A" }
A ← { session_id: "abc-123", team_id: "tid-A", cursor: 0 }

# Team B joins (out-of-band: A shares session_id with B)
B → join_session { session_id: "abc-123", team_name: "Team B" }
B ← { team_id: "tid-B", cursor: 4, participants: [...] }
  # cursor=4 because the team_joined broadcast landed at sequence 4

# Both teams enter polling loop
A → wait_for_messages { session_id: "abc-123", since_cursor: 0, timeout: 30 }
A ← { messages: [{ type:"system", content:{event:"team_joined",team:"Team B"}, sequence:4 }],
       next_cursor: 4, session_closed: false }

# B posts a message; content must be { text: "..." }
B → post_message { session_id: "abc-123", content: { text: "Team B: starting subtask Y" } }
B ← { message_id: "...", cursor: 5 }

# A's next poll picks it up
A → wait_for_messages { session_id: "abc-123", since_cursor: 4, timeout: 30 }
A ← { messages: [{ type:"chat", content:{text:"Team B: starting subtask Y"}, sequence:5 }],
       next_cursor: 5, session_closed: false }

# A appends a note to the doc
A → append_to_session_doc { session_id: "abc-123", text: "- Team A: completed subtask X" }
A ← { version: 2, updated_at: "..." }

# A concludes the session
A → conclude_session {
      session_id: "abc-123",
      summary_section: "## Conclusion\nSubtask X done (Team A). Subtask Y done (Team B)."
    }
A ← { session_id: "abc-123", status: "closed", closed_at: "...", doc_version: 3 }

# B's next poll sees session_concluded and exits
B → wait_for_messages { session_id: "abc-123", since_cursor: 5, timeout: 30 }
B ← { messages: [{ type:"system", content:{event:"session_concluded",...} }],
       next_cursor: 6, session_closed: true }
B → read_session_doc { session_id: "abc-123" }   # read final doc before exiting
B exits cleanly.

# A calls leave_session (optional for convener after conclude, but polite)
A → leave_session { session_id: "abc-123", team_id: "tid-A" }
```

---

## Implementation notes

- **Cursors are integers** (`sequence` column in Postgres). No encoding/decoding — compare and pass as integers.
- **`create_session` cursor is always 0** — the feed is empty at creation; your `since_cursor` for the first `wait_for_messages` call is `0`.
- **Re-joining:** calling `join_session` again issues a new `team_id`. There is no idempotency check on `team_name`. If you re-join, store the new `team_id`.
- **Closed sessions are readable indefinitely.** `read_session_doc`, `get_history`, `list_participants`, and `get_session` all work after close. Write ops (`post_message`, `update_session_doc`, `append_to_session_doc`, `update_session_metadata`) return `403` after close.
