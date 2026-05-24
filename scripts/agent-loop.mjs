/**
 * scripts/agent-loop.mjs
 *
 * Reference Node.js agent loop for Project-Merkle.
 *
 * Runs a persistent agent that joins a Merkle session and long-polls for
 * messages. Suitable for production deployment as a hot agent (always-on
 * process) or as the basis for a cold agent (cron-triggered with `timeout 55`).
 *
 * Requirements: Node 18+ (uses built-in fetch).
 * No npm dependencies — copy and run with: node scripts/agent-loop.mjs
 *
 * See prompts/support.md or prompts/team.md for the system prompt to feed
 * to your LLM when implementing respondToMessage().
 *
 * LLM / API env vars:
 *   ANTHROPIC_API_KEY   — Anthropic API key. When set, enables real Claude API calls.
 *                         When unset, falls back to acknowledgment-only mode.
 *   MERKLE_MODEL        — Anthropic model ID to use. Default: claude-haiku-4-5-20251001
 *   MERKLE_PROMPT_FILE  — Path to the system prompt file. Default: ../prompts/support.md
 *                         (relative to this script's directory). Falls back to an inline
 *                         default if the file is missing or unreadable.
 */

// ---------------------------------------------------------------------------
// Configuration — read from environment variables
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const MCP_URL     = process.env.MERKLE_MCP_URL    ?? "http://localhost:7423/api/mcp";
const SESSION_ID  = process.env.MERKLE_SESSION_ID  ?? "";
const PASSCODE    = process.env.MERKLE_PASSCODE    ?? "";
const TEAM_NAME   = process.env.MERKLE_TEAM_NAME   ?? "Agent";
/** If set, skip join_session and use this team_id directly (restart scenario). */
const TEAM_ID_ENV = process.env.MERKLE_TEAM_ID     ?? "";

if (!SESSION_ID) {
  console.error("[agent-loop] MERKLE_SESSION_ID is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LLM configuration — loaded once at startup
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const MODEL = process.env.MERKLE_MODEL ?? "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/** Resolve the system prompt file path (configurable, defaults to ../prompts/support.md). */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT_FILE = resolve(SCRIPT_DIR, "../prompts/support.md");
const PROMPT_FILE = process.env.MERKLE_PROMPT_FILE
  ? resolve(process.env.MERKLE_PROMPT_FILE)
  : DEFAULT_PROMPT_FILE;

const FALLBACK_SYSTEM_PROMPT =
  "You are a helpful agent participating in a multi-agent session. Reply concisely.";

/** Load the system prompt file once at startup; fall back to inline default on error. */
function loadSystemPrompt() {
  try {
    return readFileSync(PROMPT_FILE, "utf8");
  } catch {
    console.error(
      `[agent-loop] system prompt file ${PROMPT_FILE} not found — using minimal default`
    );
    return FALLBACK_SYSTEM_PROMPT;
  }
}

const SYSTEM_PROMPT = loadSystemPrompt();

if (ANTHROPIC_API_KEY) {
  console.error(`[agent-loop] Anthropic API: enabled (model: ${MODEL})`);
} else {
  console.error(
    "[agent-loop] Anthropic API: disabled (no ANTHROPIC_API_KEY in env) — running in acknowledgment-only mode"
  );
}

// ---------------------------------------------------------------------------
// Retry state
// ---------------------------------------------------------------------------

let retryDelay = 5_000;       // Start at 5s
const MAX_RETRY_DELAY = 60_000; // Cap at 60s

function resetRetry() {
  retryDelay = 5_000;
}

function backoff() {
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
}

/** Sleep for `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC transport helpers
// ---------------------------------------------------------------------------

/**
 * Low-level MCP call. Sends a JSON-RPC 2.0 request and returns the parsed
 * result payload. Throws on HTTP errors or JSON-RPC error responses.
 *
 * @param {string} method      MCP tool name
 * @param {object} args        Tool arguments
 * @param {string|null} teamId Optional team_id for authenticated calls
 */
async function mcpCall(method, args, teamId = null) {
  const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  if (teamId) headers["X-Team-ID"] = teamId;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: method, arguments: args },
  });

  const res = await fetch(MCP_URL, { method: "POST", headers, body });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} calling ${method}`);
  }

  const envelope = await res.json();

  if (envelope.error) {
    throw new Error(`MCP error in ${method}: ${JSON.stringify(envelope.error)}`);
  }

  // MCP result is { content: [{ type: "text", text: "<json string>" }] }
  const raw = envelope.result?.content?.[0]?.text;
  if (raw === undefined) {
    throw new Error(`Unexpected MCP response shape from ${method}`);
  }

  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Named functions — the public interface of this loop
// ---------------------------------------------------------------------------

/**
 * Join the session and return the assigned team_id and initial cursor.
 * Not called when MERKLE_TEAM_ID is set (restart / resume scenario).
 *
 * @returns {Promise<{ teamId: string, cursor: number }>}
 */
async function joinSession() {
  const data = await mcpCall("join_session", {
    session_id: SESSION_ID,
    team_name:  TEAM_NAME,
    passcode:   PASSCODE,
  });
  console.error(`[agent-loop] Joined session ${SESSION_ID} as "${TEAM_NAME}" → team_id=${data.team_id} cursor=${data.cursor}`);
  return { teamId: data.team_id, cursor: Number(data.cursor) || 0 };
}

/**
 * Long-poll for new messages since the given cursor.
 * The server holds the connection open for up to `timeout` seconds before
 * returning an empty message list. This call IS the heartbeat.
 *
 * @param {number}  sinceCursor Exclusive lower-bound sequence number
 * @returns {Promise<{ messages: object[], next_cursor: number, session_closed: boolean }>}
 */
async function waitForMessages(sinceCursor, teamId) {
  const data = await mcpCall(
    "wait_for_messages",
    { session_id: SESSION_ID, team_id: teamId, since_cursor: sinceCursor, timeout: 30 },
    teamId
  );
  return {
    messages:       data.messages        ?? [],
    next_cursor:    data.next_cursor      ?? sinceCursor,
    session_closed: data.session_closed   ?? false,
  };
}

/**
 * Post a chat message to the session feed.
 *
 * @param {string} text   Message text (plain, markdown OK)
 * @param {string} teamId Authenticated team_id
 */
async function postMessage(text, teamId) {
  await mcpCall(
    "post_message",
    { session_id: SESSION_ID, team_id: teamId, content: { text } },
    teamId
  );
  console.error(`[agent-loop] Posted: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {

  // Join (or resume with a pre-existing team_id from env)
  let teamId = TEAM_ID_ENV;
  let cursor = 0;
  if (teamId) {
    console.error(`[agent-loop] Resuming with MERKLE_TEAM_ID=${teamId} (skipping join_session, starting at cursor=0 — history may replay)`);
  } else {
    const result = await joinSession();
    teamId = result.teamId;
    cursor = result.cursor;
    console.error(`[agent-loop] Starting at cursor=${cursor}`);
  }

  // Poll loop
  while (true) {
    let pollResult;
    try {
      console.error(`[agent-loop] Polling since_cursor=${cursor} …`);
      pollResult = await waitForMessages(cursor, teamId);
      resetRetry();
    } catch (err) {
      console.error(`[agent-loop] Poll error: ${err.message}. Retrying in ${retryDelay / 1000}s …`);
      backoff();
      await sleep(retryDelay);
      continue;
    }

    const { messages, next_cursor, session_closed } = pollResult;

    if (session_closed) {
      console.error("[agent-loop] Session closed by server. Exiting cleanly.");
      process.exit(0);
    }

    if (messages.length === 0) {
      console.error("[agent-loop] No new messages (normal timeout). Re-polling.");
    }

    for (const message of messages) {
      // Skip own messages to avoid feedback loops.
      if (message.posted_by_team_id === teamId) continue;

      console.error(`[agent-loop] Message seq=${message.sequence} type=${message.type} from=${message.posted_by_team_id}`);

      try {
        const reply = await respondToMessage(message, { teamId, sessionId: SESSION_ID });
        if (reply) {
          await postMessage(reply, teamId);
        }
      } catch (err) {
        console.error(`[agent-loop] respondToMessage error: ${err.message}`);
      }
    }

    // Advance cursor only after processing all messages.
    cursor = next_cursor;
  }
}

// ---------------------------------------------------------------------------
// Shutdown handlers
// ---------------------------------------------------------------------------

process.on("SIGINT",  () => { console.error("[agent-loop] SIGINT — shutting down."); process.exit(0); });
process.on("SIGTERM", () => { console.error("[agent-loop] SIGTERM — shutting down."); process.exit(0); });

// ===========================================================================
// LLM HOOK — calls Anthropic API when ANTHROPIC_API_KEY is set, otherwise
// returns a simple acknowledgment so the loop is visibly working.
// ===========================================================================
//
// respondToMessage(message, ctx)
//
//   message — the raw message object from wait_for_messages:
//     {
//       sequence:           number,
//       type:               "chat" | "system",
//       content:            { text: string } | { event: string, ... },
//       posted_by_team_id:  string,
//       posted_by_name:     string,
//       created_at:         string (ISO 8601),
//     }
//
//   ctx — { teamId: string, sessionId: string }
//
//   Return: a string to post to the feed, or null/undefined to stay silent.
//
// ===========================================================================

async function respondToMessage(message, ctx) {
  // Only respond to chat messages — ignore system events (team_joined, team_dropped,
  // support_tickets_updated, etc.).
  if (message.type !== "chat") return null;

  // Skip messages carrying the acknowledgment-only canary to prevent two-agent feedback loops.
  if (typeof message.content?.text === "string" && message.content.text.includes("acknowledgment-only mode")) {
    console.error(`[agent-loop] Skipping loop-canary message seq=${message.sequence}`);
    return null;
  }

  const incomingText = message.content?.text ?? "";
  const senderName   = message.posted_by_name ?? message.posted_by_team_id ?? "unknown";

  console.error(
    `[agent-loop] Received chat seq=${message.sequence} ` +
    `from "${senderName}": ${incomingText.slice(0, 120)}`
  );

  // Acknowledgment-only mode when no API key is configured.
  if (!ANTHROPIC_API_KEY) {
    return (
      `(acknowledgment-only mode — set ANTHROPIC_API_KEY to enable real responses) ` +
      `I received your message: '${incomingText.slice(0, 100)}...'`
    );
  }

  // Real Claude API call.
  try {
    const userContent = senderName
      ? `Message from ${senderName}: ${incomingText}`
      : incomingText;

    const reqBody = JSON.stringify({
      model:      MODEL,
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: userContent }],
    });

    const res = await fetch(ANTHROPIC_API_URL, {
      method:  "POST",
      headers: {
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: reqBody,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "(unreadable body)");
      console.error(`[agent-loop] Anthropic API error ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const reply = data?.content?.[0]?.text ?? null;
    if (!reply) {
      console.error("[agent-loop] Anthropic API returned empty content.");
      return null;
    }
    return reply;
  } catch (err) {
    console.error(`[agent-loop] Anthropic API request failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(`[agent-loop] Fatal error: ${err.message}`);
  process.exit(1);
});
