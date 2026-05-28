# Project-Merkle

## Project Goal
I want to develop a web app where my agent can connect to it via an MCP layer. on the app we will be able to create sessions and join sessions of 2 or more. the sessions will say who's joined (the agents will preface who they are (e.g. Alex's Team)) and wait for other agents/teams to join the session. the purpose is for intercommunication between agents to divide and conquer complex tasks. the agents will communicate and listen to one another through GET and POSt commands, and the entire transaction history will be present when the session is open on the page so we can see what the teams are doing. I want the application built using shadcn and postgresql. you decide the rest. at the end of each session I want an agent responsible for providing a conclusion to the session in case we need to pick back up where we left off, which means a managed markdown file between all the teams is significant. One that any user accessing the session from the web can access. everyone uses claude cli and so the team would communicate through GET/POST CURL commands. Finally, when you're done, I want you to create me a set of instructions in an individual readme file that I can feed into my agent team so they have the instructions on where to go in order to interact with the MCP layer in order to create and join sessions. I want a link that the agents connect to dynamic and in our settings so we're able to adjust it if we need to.

## How Agents Stay Current

Agents don't use external watchers, daemons, or cron jobs to follow a session. They stay current by calling MCP tools that block until something happens — the MCP layer itself is the trigger mechanism.

### Long-polling with `wait_for_messages`

The core tool is `wait_for_messages(session_id, since_cursor, timeout=30s)`. When an agent calls it, the MCP server holds the request open until either:

- one or more new messages have landed in the session after `since_cursor`, or
- the 30-second timeout expires.

It returns:

```json
{
  "messages": [...],
  "next_cursor": "<id>",
  "session_closed": <bool>
}
```

If nothing arrived during the window, `messages` is an empty list — not an error. On timeout with no messages, `next_cursor` returns the same value as the input `since_cursor` — the agent re-polls with the same cursor. Keeping the timeout under 30 seconds keeps the requests well within typical HTTP/proxy idle-connection limits (usually 60–120 s) and gives each agent a natural housekeeping window on every cycle.

### Agent loop sketch

```
loop:
  result = wait_for_messages(session_id, last_cursor, timeout=30)

  if result.session_closed:
    exit cleanly

  if result.messages is empty:
    idle_count += 1
    if idle_count >= IDLE_LIMIT:   # e.g. 10 polls ≈ 5 minutes
      surface "session idle" to human
      exit
    continue

  idle_count = 0
  process(result.messages)
  post_reply_if_needed()
  last_cursor = result.next_cursor
```

### Cursor-based delivery, per team

Each team has its own `last_seen_cursor` stored server-side and keyed by team identity. Advancing one team's cursor has no effect on any other team. Cursors prevent re-reads and duplicate processing. This means the transaction feed is purely append-only — agents never delete messages, because the session page needs to show full history to anyone watching. "Clearing read messages" just means advancing a cursor, not removing rows.

### Session-closed signal

When the conclusion agent posts its final summary, the server flips `session_closed: true` on the session. The next `wait_for_messages` call from any polling agent returns `session_closed: true` so they exit cleanly instead of looping forever.

### Poll budget

Agents give up after a configurable number of consecutive empty polls (suggested default: 10, which is roughly 5 minutes of idle) and surface a "session idle" notice to the human operator. This prevents indefinite spinning on abandoned sessions.

### Read receipts (future work)

If teams ever need to know when their messages have been seen by other teams, that's a separate `POST /sessions/{id}/ack` call carrying a cursor. The ack would be written into the message record so it appears in the visible history. This isn't required for MVP — noting it here so the pattern doesn't get designed out.

## Session Roster & Participation

Every session maintains a live participant list. Teams declare themselves by calling an MCP tool, not by asking a human to add them. The roster is server-side and queryable at any time.

### Roster record structure

Each entry in the participant list carries:

| field | description |
|---|---|
| `team_id` | session-scoped opaque token, issued at join time |
| `team_name` | human-readable label the team supplies (e.g. "Alex's Team") |
| `joined_at` | timestamp of the `join_session` call |
| `last_seen_at` | timestamp of the most recent `wait_for_messages` call from this team |
| `status` | derived: `active`, `idle`, or `disconnected` |

Status is derived purely from poll activity — the `wait_for_messages` call is itself the heartbeat. There is no separate ping endpoint or keepalive mechanism. Suggested thresholds:

- **active** — poll currently in flight, or the last poll returned within the past ~10 s
- **idle** — 10–60 s since last poll
- **disconnected** — > 60 s since last poll

### Three MCP tools

**`join_session(session_id, team_name)`** registers a team and returns:

```json
{
  "team_id": "<session-scoped token>",
  "cursor": "<current end-of-feed>",
  "participants": [...]
}
```

`team_id` is the identity token the team uses for all subsequent calls in this session. `cursor` is set to the end of the feed at join time — meaning the team only sees messages going forward by default. Future variants could accept a `replay_from` parameter to let a joining team read history. `participants` is a snapshot of the full roster at the moment of join so the team can orient itself immediately.

**`leave_session(session_id, team_id)`** is the symmetric call. It posts a `team_left` system message to the feed and marks the team as `disconnected` in the roster (rather than deleting the row outright — this is an intentional choice: soft removal preserves the join/leave history in the roster table and keeps the session page's timeline coherent).

**`list_participants(session_id)`** returns the current roster with all status fields. Use this when an agent needs to ask "who else is here right now?" mid-session without waiting for the next system message to arrive.

### Join and leave events in the transaction feed

Join and leave are not delivered on a separate event channel. They are posted as typed system messages into the same append-only feed every team is already polling:

```json
{ "type": "system", "event": "team_joined", "team": "Alex's Team", "at": "<ts>" }
{ "type": "system", "event": "team_left",   "team": "Alex's Team", "at": "<ts>" }
```

This gives three things for free:

1. Join/leave history is visible on the session page alongside every other message — no separate log to consult.
2. `wait_for_messages` propagates these events to all polling teams automatically. No separate event subscription is needed.
3. Post-session reconstruction has the full context — who was present, when they joined, and when they left — in one place.

### Participation flow sketch

```
# joining
resp = join_session(session_id, team_name="Alex's Team")
team_id   = resp.team_id
last_cursor = resp.cursor

# main loop (same pattern as How Agents Stay Current)
loop:
  result = wait_for_messages(session_id, last_cursor, timeout=30)
  if result.session_closed: exit cleanly

  for msg in result.messages:
    if msg.type == "system" and msg.event == "team_joined":
      # a new team arrived — optionally greet or recheck roster
      roster = list_participants(session_id)
    else:
      process(msg)

  last_cursor = result.next_cursor

# leaving
leave_session(session_id, team_id)
```

### Session page — live roster

The session page displays the participant list with status indicators: green dot for `active`, yellow for `idle`, grey for `disconnected`. The UI refreshes as poll activity changes server-side. The exact delivery mechanism (SSE, client polling, or WebSocket) is an open implementation choice — the server-side status derivation is the same regardless.

### Commitment model

Joining a session is a stated commitment, surfaced to humans via the roster. The server does **not** prevent a team identity from being active in multiple sessions simultaneously. Enforcement is operational and social: humans see who's where on the roster page, and the documented norm is "if you're in a session, that's where your focus is."

If hard enforcement is ever needed — a team identity may only be active in one session at a time — `join_session` can be tightened to return `409 Conflict` when the team already holds an `active` or `idle` status in another session. This is a clean post-MVP tunable that requires no schema changes, just an extra check at join time.

## Session Document & Conclusion

Every session has one collaborative markdown document. It starts empty, gets built up by agents during the session, and ends as a polished handoff artifact once the conclusion agent runs a tidy pass. It's the curated "what we figured out" to go alongside the transaction feed's "what was said, in order."

### Purpose and lifecycle

The session doc is a **single markdown document per session**, scoped to that session the same way the transaction feed is. The two artifacts are complementary — not redundant:

| artifact | what it is | ordering | mutability |
|---|---|---|---|
| transaction feed | chronological transcript of every message posted | append-only, read via `wait_for_messages` (see [How Agents Stay Current](#how-agents-stay-current)) | no deletes, ever |
| session doc | curated working notes, decisions, and final summary | free-form, updated in place | readable/writable until conclusion, then read-only |

Lifecycle of the doc:

1. **Empty at session creation** — the doc field exists on the session row but is blank.
2. **Agents read and update it throughout** — anyone can append notes, record a decision, or restructure sections as work progresses.
3. **At session end, the conclusion agent runs a tidy pass** — it reads the raw working notes and calls `conclude_session` with a polished summary. What the next team picks up is something useful, not a pile of scratch work.

### Suggested doc structure

The doc is free-form markdown. There's no enforced schema — agents can structure it however fits the work. But a conventional layout helps teams collaborate without stepping on each other:

```markdown
# Session: <title>

## Goals
## Decisions
## Notes / Working
## Conclusion
```

`## Conclusion` is filled in at conclusion time. Everything else is built up during the session. Agents should generally add content under `## Notes / Working` mid-session and promote things to `## Decisions` when something is settled.

### MCP tools

**`read_session_doc(session_id)`** → returns:

```json
{ "content": "<markdown>", "version": <int> }
```

`version` increments on every write. Agents pass it back when calling `update_session_doc` so the server can detect conflicts.

---

**`update_session_doc(session_id, content, expected_version)`** → returns the new version on success. Returns `409 Conflict` if `expected_version` doesn't match the current version — meaning someone else wrote between your read and your write. On `409`, the agent re-reads, merges its intended changes with the latest content, and retries.

---

**`append_to_session_doc(session_id, text)`** → server-side atomic read + append + write. No version needed from the caller. Use this for the common case of "add a paragraph under Notes" — it eliminates the client-side retry loop entirely.

---

**`conclude_session(session_id, summary_section)`** → does three things atomically:
1. Flips `session_closed: true` on the session row.
2. Replaces the `## Conclusion` section in the doc with `summary_section` (or appends one if no `## Conclusion` section exists yet).
3. Posts a `session_concluded` system message into the transaction feed.

Returns:

```json
{
  "session_id": "<id>",
  "status": "closed",
  "closed_at": "<ts>",
  "doc_version": <int>
}
```

Step 3 is what causes the next `wait_for_messages` call from any polling agent to return `session_closed: true` — they can then exit cleanly. See [How Agents Stay Current](#how-agents-stay-current) for how agents consume that signal.

### Concurrency model

Optimistic concurrency throughout:

- Every successful write to the doc bumps the version number.
- `update_session_doc` requires `expected_version` — cheap conflict detection with no locking.
- `append_to_session_doc` is server-atomic — no version needed from the client; the server serializes the read-modify-write internally.

This is the right tradeoff for MVP. Pessimistic locking would complicate the agent loop with lock acquisition and renewal. Operational transform or CRDTs are overkill for the scale of "a few agents collaborating on a doc." The retry-on-409 path is simple and rarely triggered in practice.

### Storage

Postgres: a `session_doc` TEXT column on the `sessions` row holds the live content. A separate `session_doc_history` table snapshots the doc on every write:

| column | type | notes |
|---|---|---|
| `session_id` | FK → sessions | |
| `version` | int | monotonically increasing per session |
| `content` | TEXT | full snapshot at this version |
| `written_by` | team_id | which team wrote it |
| `at` | timestamptz | write timestamp |

This gives a full audit trail — "who changed what when" — without bloating the live `sessions` row with history. The live row stays cheap to read; history is queried only when needed.

### Web access — live-updating page

The session page renders the doc using a shadcn markdown component. Updates push to connected viewers as the doc changes server-side (same SSE / polling / WebSocket open question as the roster — server-side derivation is the same regardless of delivery mechanism).

The doc and the transaction feed render **side-by-side** on the session page: the left panel shows the chronological feed; the right panel shows the curated doc. Humans get the full picture without switching views.

### Who can conclude

**Soft default (MVP):** any team can call `conclude_session`. The expectation is that the convener — the team that created the session — runs the conclusion. Enforcement is operational, the same social pattern as the commitment model in [Session Roster & Participation](#session-roster--participation).

**Hard variant (post-MVP tunable):** restrict `conclude_session` to the convener's `team_id`. Any other team calling it gets `403 Forbidden`. No schema changes needed — just an extra check at call time, same pattern as the `409 Conflict` option on `join_session`.

**Concluding twice:** idempotent by design. A second `conclude_session` call replaces the existing `## Conclusion` section and re-posts a `session_concluded` system message. No `409`. This handles the case where the convener wants to revise the summary before walking away.

### Post-conclusion behavior

Once `session_closed: true`:

- `post_message` calls return `403 Forbidden` — the session is closed for new contributions.
- `update_session_doc` and `append_to_session_doc` are similarly gated — the doc is read-only.
- The doc and the feed remain **readable indefinitely** — `session_closed` means closed, not deleted. Resume and audit both work by reading the archived content.

### Session doc flow sketch

```
# --- agent joins ---
resp     = join_session(session_id, team_name="Alex's Team")
team_id  = resp.team_id
last_cursor = resp.cursor

doc      = read_session_doc(session_id)
doc_ver  = doc.version
# optionally add a line under Notes
append_to_session_doc(session_id, "## Notes\n- Alex's Team online, starting subtask X")

# --- mid-session: log a finding ---
append_to_session_doc(session_id, "- found that Y is the right approach because Z")

# --- main polling loop ---
loop:
  result = wait_for_messages(session_id, last_cursor, timeout=30)

  if result.session_closed:
    # conclusion agent ran — doc is finalized, exit cleanly
    final = read_session_doc(session_id)
    exit

  process(result.messages)
  last_cursor = result.next_cursor

# --- convener concludes ---
conclude_session(
  session_id,
  summary_section="## Conclusion\nSubtask X complete. Decided on approach Y. Resume from Z."
)
# server: sets session_closed, writes Conclusion into doc, posts session_concluded to feed
# all polling agents: next wait_for_messages returns session_closed: true → they exit
```

## Session Title & Description

Every session has a `title` and a `description`. `title` is short — it shows up wherever the session is referenced in the UI. `description` is longer-form: what the session is for, what the teams are trying to accomplish. Both are plain columns (`title VARCHAR`, `description TEXT`) on the `sessions` row. No separate table.

These fields are set at creation and intended to stay stable. The expectation isn't that they never change — just that they change rarely, and only when the scope or goals of the session have genuinely shifted. Typos, rephrasing, and "this wording is slightly better" are not significant changes. Metadata can also be fetched at any time (including after a page refresh) via `get_session(session_id)`, which returns title, description, status, and timestamps for any member of the session.

### Setting metadata at creation

`create_session` carries `title` and `description` as first-class parameters on day one. (Other parameters will be specced in a future section.)

```
create_session(title, description, ...)
```

From that point the session has its identity. Updating afterward requires a separate call.

### Updating metadata

**`update_session_metadata(session_id, title?, description?, reason)`** handles changes. Both `title` and `description` are optional — callers can update one or both in a single call.

The `reason` parameter is **required**. Agents must articulate why the change is significant. This is the friction point by design (more on that below).

Return shape:

```json
{
  "title": "<new or unchanged>",
  "description": "<new or unchanged>",
  "updated_at": "<ts>"
}
```

### Every update broadcasts to the feed

When `update_session_metadata` succeeds, the server posts a system message into the transaction feed — the same append-only feed every team is already polling (see [How Agents Stay Current](#how-agents-stay-current)):

```json
{
  "type": "system",
  "event": "session_metadata_updated",
  "by": "Alex's Team",
  "changes": {
    "title":       { "from": "<old>", "to": "<new>" },
    "description": { "from": "<old>", "to": "<new>" }
  },
  "reason": "<agent's reason>",
  "at": "<ts>"
}
```

This gives three things:

1. **Audit history without a separate table** — the feed is the source of truth. Consistent with how join/leave events work in [Session Roster & Participation](#session-roster--participation): significant events go into the feed, not into a sidecar log.
2. **Social pressure** — every team in the session sees the update happen. A rename doesn't happen quietly. That visibility discourages edits that aren't worth explaining.
3. **The `reason` is preserved alongside the diff** — future readers don't just see "title changed from X to Y." They see why it was worth changing.

### The "rare updates" norm

The documented expectation: agents call `update_session_metadata` only for meaningful changes to session scope or goals. Concretely, not for:

- typo fixes or punctuation
- rephrasing without a change in meaning
- "this sounds cleaner" rewrites

The required `reason` field is what enforces this norm in practice. Forcing an agent to write out "why this is significant" creates a natural pause. If the agent can't write a convincing sentence, the edit probably shouldn't happen.

This norm will be repeated in the agent-onboarding README — the separate doc agents read when they join — so it's clear from day one. That file isn't written yet; this is a forward reference.

**Post-MVP tunable:** if the soft norm proves insufficient, a server-side rate limit is a clean knob to turn: max 1 metadata update per 30 minutes per session. Exceeding it returns `429 Too Many Requests`. No schema changes required.

### Who can update

Same default as every other write tool in MVP: any team in the session can call `update_session_metadata`. Enforcement is operational and social — the broadcast makes edits visible to everyone.

Once `session_closed: true`, the tool returns `403 Forbidden`. Same gating as `post_message`, `update_session_doc`, and `append_to_session_doc` — see [Session Document & Conclusion](#session-document--conclusion).

**Hard variant (post-MVP tunable):** restrict updates to the convener's `team_id`. Any other team calling it gets `403 Forbidden`. Same enforcement pattern as the `conclude_session` restriction in the prior section — no schema changes, just an extra check at call time.

### Concurrency

Last-write-wins. No version token, no `409 Conflict` retry loop.

Optimistic locking would be overkill here. `title` and `description` change at most once or twice in a session's lifetime — nothing like the granular, concurrent writes that make optimistic concurrency worth the complexity in the session doc. Any write race is benign: updates are rare, and they broadcast to every team immediately. Both teams will see what happened on their next poll.

Contrast with [Session Document & Conclusion](#session-document--conclusion), where the doc uses optimistic concurrency because writes are frequent and granular.

### UI rendering

`title` and `description` display at the top of the session page — above the roster and the doc/feed split-pane. They're the first thing a human sees when they open the session.

When an update lands server-side and the corresponding `session_metadata_updated` message appears in the feed, the title and description animate briefly to signal the change. The delivery mechanism — SSE, client polling, or WebSocket — is the same open implementation choice as the rest of the page.

## MCP Server

This section specifies the transport, auth model, full tool surface, error contract, and data schema for the MCP layer. Prior sections describe individual tools in context; this section is the single-page reference that ties everything together.

### Connection model

**Transport: HTTP + Server-Sent Events (SSE).** Long-poll endpoints (`wait_for_messages`) stream the response over SSE, holding the connection open until messages arrive or the timeout expires. All other endpoints are plain HTTP request/response. This decision rejects:

- `stdio` — agents may run on different machines; stdio requires a shared process boundary.
- Pure HTTP polling — short-polling `wait_for_messages` would require the client to drive timing and would waste requests; SSE lets the server push when ready.

**Backend: Next.js App Router, TypeScript strict, deployed as `output: "standalone"`.** The server runs as a long-lived Node process, not a serverless function. Tool endpoints live under `app/api/` as Route Handlers. Single repo for backend and the shadcn frontend. This decision rejects pure serverless: a long-poll connection held open for up to 30 seconds exceeds typical function timeout limits and kills cold-start economics.

**Hosting: deferred.** Fly.io and Railway are the natural candidates given the long-poll requirement — both support persistent processes without per-request billing. The final choice lives at scaffolding time, outside this spec.

**MCP endpoint URL — dynamic, not hardcoded.** The project goal explicitly calls for the connection URL to be a configurable dynamic link. Agents read it from configuration at startup:

```json
{ "mcp_url": "https://your-host/mcp" }
```

or from a single environment variable:

```
MCP_URL=https://your-host/mcp
```

Changing the URL requires only a config edit — no code change, no redeploy of the agent. The agent-onboarding README (forward-referenced in [Session Title & Description](#session-title--description)) will document the exact field name and lookup order.

### Auth flow

Auth is session-scoped. Two tools issue tokens; all other tools consume them.

**Issuing a token:**

- `create_session(title, description, creator_team_name)` — convener path. Creates the session and automatically registers the creating team. Returns a `team_id` immediately. No separate `join_session` call needed.
- `join_session(session_id, team_name)` — joiner path. Returns a `team_id` for that session.

Both endpoints require **no auth** — they are the entry points.

**Using a token:**

All subsequent calls must carry:

```
X-Team-ID: <token>
```

The server validates two things on every authenticated request:

1. The token exists in the database.
2. The token maps to an active membership in the supplied `session_id`.

Either check failing returns `401 Unauthorized`. There is no distinction between "token doesn't exist" and "token is for a different session" — both return `401`.

**Token properties:**

- Opaque — server-generated (e.g., UUID or short crypto-random string). Not a JWT; the server is the authority.
- Session-scoped — a `team_id` is meaningful only within the session that issued it. The same human team joining two sessions gets two independent `team_id` tokens.
- Expiry — the token is live as long as the session is active. When `session_closed: true` is set, the token becomes invalid for write operations (`post_message`, `update_session_doc`, `append_to_session_doc`, `update_session_metadata` all return `403 Forbidden`). Read operations (`read_session_doc`, `list_participants`, `get_history`) remain valid indefinitely — closed sessions are still readable.

**Post-MVP auth hardening (out of scope for MVP):** connection-level auth on the MCP endpoint itself (shared secret, OAuth). For MVP there is no authentication at the transport level — any agent that knows the URL can call `create_session` or `join_session`.

### Complete tool surface

All 13 tools, grouped by concern:

| tool | purpose | auth required? |
|---|---|---|
| `create_session(title, description, creator_team_name)` | create a new session; convener auto-joins and receives a `team_id` | no |
| `join_session(session_id, team_name)` | join an existing session; receive a `team_id` | no |
| `leave_session(session_id, team_id)` | soft-remove from the session; posts `team_left` to feed | yes |
| `list_participants(session_id)` | fetch the current roster with status fields | yes |
| `get_session(session_id)` | fetch session metadata (title, description, status, timestamps) | yes |
| `wait_for_messages(session_id, since_cursor, timeout)` | long-poll for new feed messages; SSE-streamed response | yes |
| `post_message(session_id, content, type?)` | post a chat message to the transaction feed | yes |
| `get_history(session_id, before_cursor?, limit?)` | paginated backwards read of feed history | yes |
| `read_session_doc(session_id)` | read the session doc and its current version | yes |
| `update_session_doc(session_id, content, expected_version)` | full doc replace with optimistic concurrency | yes |
| `append_to_session_doc(session_id, text)` | server-atomic append to doc; no version token needed | yes |
| `update_session_metadata(session_id, title?, description?, reason)` | update title/description; `reason` required; broadcasts to feed | yes |
| `conclude_session(session_id, summary_section)` | close the session, write Conclusion into doc, broadcast `session_concluded` | yes |

Ten of these tools are fully specced in their dedicated sections — refer to those rather than duplicating the detail here:

- `wait_for_messages` → [How Agents Stay Current](#how-agents-stay-current)
- `join_session`, `leave_session`, `list_participants` → [Session Roster & Participation](#session-roster--participation)
- `read_session_doc`, `update_session_doc`, `append_to_session_doc`, `conclude_session` → [Session Document & Conclusion](#session-document--conclusion)
- `update_session_metadata` → [Session Title & Description](#session-title--description)
- `get_session` — returns `{ session_id, title, description, status, created_at, closed_at, session_doc_version }`; auth required; only session members may call it.

The three tools below are specced here for the first time.

#### `create_session(title, description, creator_team_name)`

Creates a new session and immediately registers the creating team as the convener. No follow-up `join_session` call is needed.

Returns:

```json
{
  "session_id": "<id>",
  "team_id": "<convener's session-scoped token>",
  "cursor": "<starting cursor — current end of feed>",
  "title": "<as supplied>",
  "description": "<as supplied>"
}
```

Notes:

- `cursor` is `0` — the feed is empty at session creation, so the convener can begin polling from sequence 0.
- `title` and `description` follow the same rules as `update_session_metadata` — see [Session Title & Description](#session-title--description) for constraints and conventions.
- No auth required. Future hardening: invite-token or connection-level auth at `create_session` (post-MVP).
- The convener's `team_id` is the identity used to call `conclude_session`. If the hard-enforcement variant is enabled post-MVP, only this token can conclude the session.

#### `post_message(session_id, content, type?)`

Posts a message to the transaction feed. The message is immediately visible to all teams on their next `wait_for_messages` call.

Returns:

```json
{
  "message_id": "<id>",
  "cursor": "<sequence number of this message>",
  "at": "<ts>"
}
```

Notes:

- `type` defaults to `"chat"`. **Agents can only post `type: "chat"`.** System message types (`team_joined`, `team_left`, `session_metadata_updated`, `session_concluded`, etc.) are server-generated. If a client attempts to supply a system type, the server returns `400 Bad Request` — no spoofing.
- `content` is an object `{ text: string }` where `text` is the message body. Markdown is allowed; the UI renders it.
- The returned `cursor` is the sequence number of the posted message. A posting agent may advance its own `last_cursor` past this value so its next `wait_for_messages` call skips its own post — but this is optional. If the agent doesn't advance, the next poll returns the message and the agent can identify it by `posted_by_team_id`.
- Returns `403 Forbidden` once `session_closed: true`. See [Session Document & Conclusion](#session-document--conclusion) for the full post-conclusion gating behavior.

#### `get_history(session_id, before_cursor?, limit?)`

Paginated backwards read of the transaction feed. Fetches messages older than `before_cursor`.

Returns:

```json
{
  "messages": [...],
  "next_cursor": "<id or null>",
  "has_more": <bool>
}
```

Notes:

- **Backwards pagination** — each page goes further into the past. This is the correct direction for "show me what I missed" and audit reads. Messages within each returned page are ordered ascending (oldest first within the page) for friendlier rendering.
- `before_cursor` is optional. If omitted, the call returns the most recent batch — the tail of the feed.
- `limit` defaults to **100**, maximum **500**. The server clamps silently: values above 500 are treated as 100, not rejected. There is no error for an out-of-range `limit`.
- `has_more: true` means older messages exist. Pass `next_cursor` as `before_cursor` on the next call to continue paging backwards. When `has_more: false`, you've reached the beginning of the feed.
- `get_history` is not the primary read path — that's `wait_for_messages` (see [How Agents Stay Current](#how-agents-stay-current)). Use `get_history` for cold reads, replays on join, or audit. The `replay_from` extension hinted at in [Session Roster & Participation](#session-roster--participation) would be implemented on top of this tool.

### Error model

All error responses return a structured body — never a plain string, never an HTML error page:

```json
{ "error": { "code": "<short_code>", "message": "<human-readable>", "details": {} } }
```

`details` carries structured context when useful (e.g., which field failed validation, what the current version is on a `409`). It may be an empty object. Internals — stack traces, query text, internal IDs — are never included in the error response; they go to server logs only.

| code | meaning | typical cause |
|---|---|---|
| `200 OK` | success | normal response |
| `400 Bad Request` | malformed input | missing required field, invalid type, attempted system-message spoofing via `post_message` |
| `401 Unauthorized` | missing or invalid `X-Team-ID` | header absent, token doesn't exist, or token doesn't map to an active membership in the given `session_id` |
| `403 Forbidden` | access denied | `session_closed: true` on a write tool; post-MVP: convener-only enforcement on `conclude_session` or `update_session_metadata` |
| `404 Not Found` | resource missing | `session_id` or `team_id` doesn't exist in the database |
| `409 Conflict` | optimistic concurrency mismatch | `expected_version` on `update_session_doc` doesn't match the current version — re-read, merge, retry |
| `429 Too Many Requests` | rate-limit hit | post-MVP rate limiting on metadata and doc updates (see [Session Title & Description](#session-title--description)) |
| `500 Internal Server Error` | server bug | unexpected exception — log with full context server-side, return a generic message to the client |

### Postgres schema sketch

Four tables. Field names and types are listed here as implementation guidance — the actual migration DDL is left to the scaffolding phase.

**`sessions`**

| field | type | notes |
|---|---|---|
| `id` | uuid | primary key |
| `title` | varchar | set at creation |
| `description` | text | set at creation |
| `session_doc` | text | live content; starts empty |
| `session_doc_version` | int | increments on every write |
| `created_by_team_id` | uuid | convener's `team_id` |
| `created_at` | timestamptz | |
| `closed_at` | timestamptz | nullable; set by `conclude_session` |
| `status` | enum | `active` \| `closed` |

**`participants`**

| field | type | notes |
|---|---|---|
| `session_id` | uuid | FK → sessions; part of composite PK |
| `team_id` | uuid | part of composite PK |
| `team_name` | varchar | as supplied at join time |
| `joined_at` | timestamptz | |
| `last_seen_at` | timestamptz | updated on every `wait_for_messages` call |
| `status` | enum | `active` \| `idle` \| `disconnected`; derived from `last_seen_at` |

Composite primary key on `(session_id, team_id)`.

**`messages`**

| field | type | notes |
|---|---|---|
| `id` | uuid | primary key |
| `session_id` | uuid | FK → sessions |
| `posted_by_team_id` | uuid | nullable — null for server-generated system messages |
| `type` | enum | `chat` \| `system` |
| `content` | jsonb | chat: `{ "text": "..." }`; system: varies by event type |
| `posted_at` | timestamptz | |
| `sequence` | bigint | monotonically increasing per session — **this is the cursor** |

Cursor comparisons in `wait_for_messages` and `get_history` are integer comparisons on the `sequence` column. There is no cursor encoding or decoding step.

**`session_doc_history`**

| field | type | notes |
|---|---|---|
| `session_id` | uuid | FK → sessions; part of composite PK |
| `version` | int | part of composite PK; matches `session_doc_version` on `sessions` |
| `content` | text | full doc snapshot at this version |
| `written_by_team_id` | uuid | which team wrote it |
| `written_at` | timestamptz | |

Composite primary key on `(session_id, version)`. See [Session Document & Conclusion](#session-document--conclusion) for how the live doc and history table work together.

### Out of scope for MVP

The following are deliberately deferred. They are noted here so they don't get accidentally designed out of the schema or the tool signatures:

- **Connection-level auth** on the MCP endpoint itself — shared secret or OAuth. MVP has no transport-level auth. See [Auth flow](#auth-flow) above.
- **Multi-tenancy and org-level isolation** — all sessions exist in a single namespace. No team or org scoping.
- **Federation across MCP servers** — one server per deployment. Cross-server session participation is not designed.
- **Rate limiting** — the `429` code is reserved and the schema supports it, but no enforcement is implemented. Post-MVP knob; see [Session Title & Description](#session-title--description).
- **Hard convener-only enforcement** — `conclude_session` and `update_session_metadata` currently allow any session participant. The `403` path exists in the error model but is not triggered in MVP. Post-MVP tunable; see [Session Document & Conclusion](#session-document--conclusion) and [Session Title & Description](#session-title--description).
- **Session export and archival** — closed sessions remain in Postgres indefinitely. Export to durable external storage (S3, etc.) is not implemented.
- **Encryption at rest** — beyond what the Postgres deployment provides natively. No application-level encryption of `content`, `session_doc`, or `team_name` fields.

## Running

### Prerequisites

- Node 20+, npm (all modes)
- Docker Desktop (for running Postgres in a container)
- Postgres 13+ locally (no-Docker dev mode only)

---

### Mode A — Dev on host, Postgres in Docker (recommended for active development)

The dev server binds to host port 7423 by default (set in `package.json` and via `next dev -p 7423`). Change it in `package.json` and `.env.local` if you need a different port.

```bash
cp .env.example .env.local          # adjust DATABASE_URL if needed
docker compose up -d postgres        # start only the Postgres container
npm install
npm run db:migrate                   # applies drizzle/0000_short_purifiers.sql
npm run dev
```

Open http://localhost:7423. The `postgres` service exposes port 5433 on localhost
(port 5433 is used on the host to avoid colliding with a native Postgres install — the
container still listens on 5432 internally), so `.env.local`'s default `DATABASE_URL`
works without any edits.

---

### Mode B — Production build on host, Postgres in Docker

The app no longer runs in Docker. Only Postgres runs in a container. For a production-style
build on the host:

```bash
docker compose up -d postgres        # start only the Postgres container
cp .env.example .env.local           # set DATABASE_URL=postgresql://merkle:merkle_dev@localhost:5433/merkle
npm install
npm run db:migrate
npm run build
npm start
```

Open http://localhost:7423 (or whatever port `npm start` binds — set `PORT` in `.env.local` if needed).

> **Production note:** `POSTGRES_PASSWORD: merkle_dev` in `docker-compose.yml` is the
> local-dev default. Override it via environment variable before deploying to any
> public-facing host.

---

### Mode C — Full local install (no Docker)

1. Start your local Postgres and create a `merkle` database.
2. `cp .env.example .env.local` and set `DATABASE_URL` to your local connection string.
3. `npm install`
4. `npm run db:migrate`
5. `npm run dev`

---

### For agents

Point agents at `./AGENTS.md` for the full tool reference and call patterns. The MCP endpoint is:

```
http://localhost:7423/api/mcp
```

Controlled by `MCP_URL` in `.env.local` — change it after deployment without touching code or redeploying agents.

---

### Production deployment

`output: "standalone"` is set in `next.config.js`. `Dockerfile` can still be used to build a
standalone image for deployment to Fly.io, Railway, or any host that supports persistent
long-running Node processes (required for the long-poll endpoints — serverless function timeouts
are too short). When deploying via Docker image, inject `DATABASE_URL` (and any other runtime secrets such as
`POSTGRES_PASSWORD`) as environment variables at runtime; `NEXT_PUBLIC_MCP_URL` is baked into the
client bundle at build time and cannot be changed at container runtime — see [Deployment](#deployment)
for the build-arg pattern. Run migrations (`npm run db:migrate`) against the target database before
starting the container.

---

## Deployment

Prod deployments are agent-driven and follow `prompts/deploy.md`. The TL;DR:

- Prod runs the image `aaarbuckle/project-merkle:main` pulled from Docker Hub, with Watchtower auto-updating on push.
- `NEXT_PUBLIC_MCP_URL` is baked into the client bundle at `docker build` time via `--build-arg`. It cannot be changed at container runtime — Next.js inlines `NEXT_PUBLIC_*` vars during `next build`.
- To deploy, hand `prompts/deploy.md` to an agent (or follow it manually) on a machine with Docker daemon + push credentials. The agent will build with the correct `NEXT_PUBLIC_MCP_URL`, push, and Watchtower handles the rest.

See `prompts/deploy.md` for the full procedure.