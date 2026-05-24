import "server-only";

/**
 * Vault filesystem boundary for the "support session" feature.
 *
 * SAFETY CONTRACT (enforced here, last line of defense):
 * - This module is the ONLY place in the codebase that constructs a filesystem
 *   path inside ${SWT_OBSIDIAN_PATH}. All vault reads/writes funnel through here.
 * - The single mutation export is `appendIssueToTicket()` — append-only, single
 *   bullet per call, atomic write via tmp+rename onto the SAME target path.
 * - Deletion-capable Node APIs are deliberately ABSENT from imports:
 *   no `rm`, no `unlink`, no `rmdir`, no `truncate`, no `cp`. The only `rename`
 *   use case is moving a freshly-created tmp file onto its target.
 * - Defense-in-depth: regex-validated keys + `path.resolve` + vault-root prefix
 *   check guard against path traversal; `lstat().isSymbolicLink()` rejects
 *   symlink escapes on every read/append.
 * - The `absolutePath` field on `VaultTicket` is server-internal. The MCP tools
 *   (Wave 2) that surface tickets to agents MUST strip `absolutePath` before
 *   serializing the response to clients.
 */

import {
  readFile,
  writeFile,
  lstat,
  rename,
  readdir,
} from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { hiddenProjects, isHidden } from "./hidden";

// ----- Types -----

export type VaultTicket = {
  /** "<PROJECT>/<NUMBER>" — the canonical key used in MCP tools and DB rows. */
  key: string;
  /** "<PROJECT>" component, e.g. "CMMS". */
  project: string;
  /** "<NUMBER>" component, e.g. "2942". String-typed because Obsidian numbers can have leading zeros or non-numeric suffixes. */
  number: string;
  /** Absolute path to the .md file. Used by the SERVER only — never returned to clients. */
  absolutePath: string;
};

export type TicketContent = {
  key: string;
  content: string;
};

export type VaultErrorCode =
  | "not_configured"
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "internal";

export class VaultError extends Error {
  constructor(
    public code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

// ----- Constants -----

const TICKET_KEY_RE = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/;
const NAME_COMPONENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SECTION_HEADING = "## Issues Found in Support";
const MAX_ISSUE_LEN = 2000;
const MAX_TEAM_LEN = 256;

// ----- Public functions -----

/**
 * Returns the resolved absolute path of the vault root. Computed lazily on
 * every call so tests/config changes are observed immediately.
 *
 * Throws `VaultError("not_configured")` if SWT_OBSIDIAN_PATH is missing/empty.
 */
export function getVaultRoot(): string {
  const raw = process.env.SWT_OBSIDIAN_PATH;
  if (!raw || raw.trim().length === 0) {
    throw new VaultError(
      "not_configured",
      "SWT_OBSIDIAN_PATH is not set",
    );
  }
  return path.resolve(raw);
}

/**
 * The ONLY function in the codebase that builds a real filesystem path inside
 * the vault. Validates the key shape, resolves against the vault root, and
 * asserts containment (defense-in-depth against traversal).
 */
export function resolveTicketFilePath(key: string): string {
  if (typeof key !== "string" || !TICKET_KEY_RE.test(key)) {
    throw new VaultError("bad_request", "Invalid ticket key");
  }
  const slash = key.indexOf("/");
  const project = key.slice(0, slash);
  const number = key.slice(slash + 1);

  const vaultRoot = getVaultRoot();
  const candidate = path.resolve(vaultRoot, project, number + ".md");

  // Containment check: candidate must live strictly inside vaultRoot.
  if (!candidate.startsWith(vaultRoot + path.sep)) {
    throw new VaultError("forbidden", "Path escapes vault");
  }
  return candidate;
}

/**
 * Enumerates tickets one level deep: each subdirectory of the vault root is a
 * project; each `.md` file inside is a ticket. Symlinks are rejected. Entries
 * whose names don't match the strict component regex are silently SKIPPED so
 * stray folders (e.g. ".obsidian") don't break enumeration.
 */
export async function listVaultTickets(): Promise<VaultTicket[]> {
  const vaultRoot = getVaultRoot();

  let projectEntries;
  try {
    projectEntries = await readdir(vaultRoot, { withFileTypes: true });
  } catch {
    throw new VaultError("not_found", "Vault directory unreadable");
  }

  const tickets: VaultTicket[] = [];

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const project = projectEntry.name;
    if (!NAME_COMPONENT_RE.test(project)) continue;
    if (hiddenProjects.includes(project)) continue;

    const projectDir = path.join(vaultRoot, project);

    let ticketEntries;
    try {
      ticketEntries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      // Project subdir became unreadable mid-scan; skip rather than abort.
      continue;
    }

    for (const ticketEntry of ticketEntries) {
      if (!ticketEntry.isFile()) continue;
      const name = ticketEntry.name;
      if (!name.endsWith(".md")) continue;
      const number = name.slice(0, -3);
      if (!NAME_COMPONENT_RE.test(number)) continue;

      const key = `${project}/${number}`;
      if (isHidden(key)) continue;
      let absolutePath: string;
      try {
        absolutePath = resolveTicketFilePath(key);
      } catch {
        // Validation failed (shouldn't happen — we just regex'd both halves —
        // but if it does, skip rather than abort enumeration).
        continue;
      }

      // Symlink defense: lstat the candidate and skip symlinks. A symlink in
      // the vault tree could redirect reads/writes outside the vault.
      try {
        const st = await lstat(absolutePath);
        if (st.isSymbolicLink()) continue;
        if (!st.isFile()) continue;
      } catch {
        continue;
      }

      tickets.push({ key, project, number, absolutePath });
    }
  }

  tickets.sort((a, b) => {
    if (a.project !== b.project) return a.project < b.project ? -1 : 1;
    if (a.number !== b.number) return a.number < b.number ? -1 : 1;
    return 0;
  });

  return tickets;
}

/**
 * Server-mediated read of one ticket file. The CALLER (MCP tool handler) is
 * responsible for confirming the `key` matches the session's
 * `selected_ticket_key` — this function does NOT enforce selection state; it
 * only enforces the path-safety contract.
 */
export async function readTicketContent(key: string): Promise<TicketContent> {
  const absolutePath = resolveTicketFilePath(key);

  if (isHidden(key)) {
    throw new VaultError("forbidden", `Ticket "${key}" is not available`);
  }

  let st;
  try {
    st = await lstat(absolutePath);
  } catch {
    throw new VaultError("not_found", "Ticket file not found");
  }
  if (st.isSymbolicLink()) {
    throw new VaultError("forbidden", "Ticket path is a symlink");
  }
  if (!st.isFile()) {
    throw new VaultError("not_found", "Ticket file not found");
  }

  const content = await readFile(absolutePath, "utf-8");
  return { key, content };
}

/**
 * THE BLESSED WRITE PATH. The only function in the codebase that mutates a
 * file in the vault. Append-only at EOF, single bullet per call, atomic write
 * via tmp+rename. The caller MUST source `args.key` from
 * `sessions.selected_ticket_key`, never from agent-supplied input.
 */
export async function appendIssueToTicket(args: {
  key: string;
  issueText: string;
  byTeamName: string;
}): Promise<{ key: string; appendedAt: string }> {
  // ----- Input validation -----
  if (
    typeof args.issueText !== "string" ||
    args.issueText.length < 1 ||
    args.issueText.length > MAX_ISSUE_LEN ||
    args.issueText.includes("\n") ||
    args.issueText.includes("\r")
  ) {
    throw new VaultError("bad_request", "Issue text invalid");
  }
  if (
    typeof args.byTeamName !== "string" ||
    args.byTeamName.length < 1 ||
    args.byTeamName.length > MAX_TEAM_LEN
  ) {
    throw new VaultError("bad_request", "Team name invalid");
  }

  if (isHidden(args.key)) {
    throw new VaultError("forbidden", `Ticket "${args.key}" is not available`);
  }

  const absolutePath = resolveTicketFilePath(args.key);

  // ----- Symlink / regular-file guard -----
  let st;
  try {
    st = await lstat(absolutePath);
  } catch {
    throw new VaultError("not_found", "Ticket file not found");
  }
  if (st.isSymbolicLink()) {
    throw new VaultError("forbidden", "Ticket path is a symlink");
  }
  if (!st.isFile()) {
    throw new VaultError("not_found", "Ticket file not found");
  }

  // ----- Compose append-only payload -----
  const original = await readFile(absolutePath, "utf-8");
  const appendedAt = new Date().toISOString();
  const entry = `\n- ${appendedAt} [${args.byTeamName}]: ${args.issueText}\n`;

  // Detect existing section heading. The heading is considered present iff
  // followed by a newline or end-of-file (so we don't false-match a heading
  // that's actually a longer string like "## Issues Found in Supportable").
  const headingPresent =
    original.includes(SECTION_HEADING + "\n") ||
    original.endsWith(SECTION_HEADING);

  let newContent: string;
  if (!headingPresent) {
    // Lazy-create section. Trim trailing whitespace, ensure exactly one blank
    // line precedes the new heading.
    const trimmed = original.replace(/\s+$/u, "");
    newContent = `${trimmed}\n\n${SECTION_HEADING}\n${entry}`;
  } else {
    // Append-at-EOF. The leading "\n" in `entry` covers the case where the
    // file doesn't end with a newline.
    newContent = original.endsWith("\n")
      ? original + entry.slice(1)
      : original + entry;
  }

  // ----- Non-additive guard -----
  if (newContent.length <= original.length) {
    throw new VaultError("internal", "Refusing to write non-additive content");
  }

  // ----- Atomic write: tmp + rename onto same target -----
  const tmpSuffix = crypto.randomBytes(8).toString("hex");
  const tmpPath = `${absolutePath}.swt-tmp-${tmpSuffix}`;

  // `wx` => fail if tmp file somehow already exists. We never overwrite.
  await writeFile(tmpPath, newContent, { encoding: "utf-8", flag: "wx" });

  try {
    await rename(tmpPath, absolutePath);
  } catch (err) {
    // Rename failed. Tmp file may be left behind. We deliberately do NOT
    // import deletion APIs, so we can't clean it up. Log and re-throw — a
    // stray `.swt-tmp-*` next to the ticket is acceptable cost.
    console.error(
      "[vault] atomic rename failed; tmp file may be left at",
      tmpPath,
      err,
    );
    throw err;
  }

  return { key: args.key, appendedAt };
}
