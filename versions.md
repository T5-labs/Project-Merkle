# Version History

A chronological log of changes, newest first. Each version's heading anchor is auto-derived from its slug (e.g. `## v0.19.0` → `#v0190`).

---

## v0.19.0

**Released:** 2026-05-24

### Added
- Version history page (`/versions`) with anchor-link sidebar TOC and back-to-dashboard button.
- Home-page version number is now a clickable link to the new history page.

### Why
- Visibility into iteration history without needing to read the Obsidian project notes.

---

## v0.18.1

**Released:** 2026-05-24

### Fixed
- Invalid `hsla(...)` CSS syntax in `DotFieldBackground` was silently dropping dark-mode dots — replaced with valid `rgba(...)` values.

### Changed
- Warmer light-mode and dark-mode dot tones to better harmonize with the warm off-white / off-black palette.

---

## v0.18.0

**Released:** 2026-05-24

### Added
- `Join` tooltip on the right-arrow join button on session list cards.
- Green `active` and red `closed` badge variants, matching the system-event pill styling used in the feed.

### Changed
- Session join affordance refactored from a labeled button to a borderless, full-height arrow sliver on the card edge — cleaner visual weight.

---

## v0.17.1 – v0.17.11

**Released:** 2026-05-24

Patch-bump iterations between v0.17.0 and v0.18.0 — polish and small refinements (detailed history unrecovered).

---

## v0.17.0

**Released:** 2026-05-24

### Added
- `/api/health` endpoint (`app/api/health/route.ts`) — returns `{ status, name, version, time }` JSON, `Cache-Control: no-store`, no auth.
- Used by Nomeda's `integration.merkle` module's `verifyOnConnect` flow.

---

## v0.16.0 – v0.16.3

**Released:** 2026-05-24

### Added (v0.16.0)
- Real LLM integration in `scripts/agent-loop.mjs`: `respondToMessage()` now POSTs to the Anthropic API when `ANTHROPIC_API_KEY` is set, reading the system prompt from `MERKLE_PROMPT_FILE` and the model from `MERKLE_MODEL` (default `claude-haiku-4-5-20251001`). Graceful degradation: acknowledgment-only mode when no API key is set.

### Fixed (v0.16.1 – v0.16.3)
- v0.16.1: Added missing `Accept: application/json, text/event-stream` header (was returning HTTP 406 on first call).
- v0.16.2: Passcode plumbing — script was sending passcode as an HTTP header; server expects it in JSON-RPC `arguments`.
- v0.16.3: Two latent bugs — `get_session` doesn't return a `cursor` field (now uses cursor from `join_session` response); added canary check to prevent acknowledgment-loop when two auto-responders share a session.

---

## v0.15.0 – v0.15.2

**Released:** 2026-05-24

### Added (v0.15.0)
- `scripts/agent-loop.mjs` (292 lines, no npm deps, Node 18+) — reference autonomous-agent runtime. Reads env vars (`MERKLE_MCP_URL`, `MERKLE_SESSION_ID`, `MERKLE_PASSCODE`, `MERKLE_TEAM_NAME`). Loops `wait_for_messages(timeout=30)` forever; handles exponential backoff, SIGINT/SIGTERM clean shutdown, self-message filtering, cursor tracking, and clean exit on `session_closed: true`.
- Production deployment notes added to `prompts/support.md` and `prompts/team.md` covering both hot-agent (systemd/PM2/Docker) and cold-agent (cron with `timeout 55 node`) patterns.

### Changed (v0.15.1 – v0.15.2)
- v0.15.1: Identity + idle-loop guidance in both prompts — `team_name` on announce only, no model/version self-disclosure; "idle = inside the loop, not outside it" reinforcement.
- v0.15.2: Dropped the `{TEAM_NAME}:` message-prefix convention (stale since 2026-05-09 — UI now attributes messages natively). All prompt examples de-prefixed. New "Runtime" note clarifying that turn-based harnesses (Claude Code, Claude Desktop) won't auto-loop without `/loop`.

---

## v0.14.0 – v0.14.1

**Released:** 2026-05-24

### Added (v0.14.0)
- Hide-list pattern matching: `hiddenTicketNames` (exact name, project-agnostic) and `hiddenTicketNameSuffixes` (suffix match). Initial population: `hiddenProjects: ['evermont']`, `hiddenTicketNames: ['Migrations']`, `hiddenTicketNameSuffixes: ['Notes', 'Installation', 'Support']`.
- Ticket picker UI replaced shadcn `<Select>` with a searchable Combobox (`cmdk` + `Popover` + `Command`). Filter matches project name and ticket number.
- New shadcn primitives: `components/ui/popover.tsx`, `components/ui/command.tsx`.

### Fixed (v0.14.1)
- Long-standing heartbeat-sweep race: the caller's own stale `last_seen_at` was triggering self-disconnect before the heartbeat update landed.
  - Fix B: `sweepStaleParticipants(sessionId, excludeTeamId?)` now skips the caller's own row.
  - Fix C: new `reactivateIfStaleDropped()` — flips `disconnected → active` on fresh heartbeat, but only when the most recent status event was `team_dropped` (swept) not `team_left` (explicit goodbye). Broadcasts new `team_rejoined` system event.
- UI handler for `team_rejoined` added to `feed-panel.tsx`.

---

## v0.13.0

**Released:** 2026-05-24

### Added
- Support hide list: `lib/support/hidden.ts` with `hiddenProjects` (exact project match) and `hiddenTickets` (exact full-key match) arrays.
- Hide list enforced at three points in `lib/support/vault.ts`: `listVaultTickets()` (filter), `readTicketContent()` (refuses with `VaultError('forbidden')`), `appendIssueToTicket()` (same defense).
- Replace-on-refresh auto-clears stale selections via `replaceSupportTicketOptions`.

---

## v0.12.0 – v0.12.1

**Released:** 2026-05-24

### Changed (v0.12.0)
- Eliminated the agent-onboarding restart requirement: `team_id` now flows via JSON-RPC `params.arguments.team_id` on every authed tool call; `X-Team-ID` header preserved as backward-compat fallback. Every tool schema (sessions, feed, doc, support) gained an optional `team_id` field. `.mcp.json` headers block removed.
- Both invitation prompt templates (`prompts/team.md`, `prompts/support.md`) rewritten to the new 2-step flow (was 4 steps requiring `.mcp.json` edit + Claude Code restart).

### Added (v0.12.1)
- Inline share-dialog and `get_app_info` invitation templates updated to drop the `.mcp.json` restart instructions.

**Architectural note:** MCP SDK only exposes `headers` + `url` on `extra.requestInfo`, not the request body — middleware-only auth is not feasible; per-tool `requireTeamId(args, extra)` is the correct pattern.

---

## v0.11.0 – v0.11.8

**Released:** 2026-05-24

### Added
- Persistent error notification: `lib/client/error-toast.tsx` — a sticky neutral `toast()` (not `toast.error()`) with `duration: Infinity` and `closeButton: true`.
- Inline `AlertCircle` icon next to the title (inherits `currentColor`).
- Fixed-height monospace code block description (`bg-muted`, `text-sm font-mono`, `max-h-[220px] overflow-y-auto`, `whitespace-pre-wrap break-all`).
- Hover-reveal Copy button (top-left of code block), `opacity-0 group-hover:opacity-100`, `bg-background/80 backdrop-blur-sm` chip, `Copy`/`Check` toggle icon.
- Wired into 8 server-error mutation paths: createSession, joinSession, leaveSession, updateMetadata, concludeSession, reopenSession, postMessage.

Iterated 8 patches across the session — color scheme, padding, alignment, icon position — landing at `text-base font-semibold` title and top-left copy button.

**Internal note:** `icon: null` (not `false`) is required — sonner v2 checks `icon !== null` specifically to collapse the icon slot.

---

## v0.0.0 – v0.10.x

**Released:** 2026-05-24 (morning)

Initial scaffold and foundational features built across the morning of 2026-05-24 (detailed pre-v0.11 history not recovered).

Includes: Next.js App Router bootstrap, Drizzle + Postgres schema, full MCP tool surface (12 tools), session feed with long-poll, roster heartbeat, session document with optimistic locking, support feature build-out (vault.ts, `lib/support/`), persistent error toast foundations, session header restructure, tabs in title bar, WSL HMR polling fix, dark mode via `next-themes`, dot-field background, versioning convention installed.
