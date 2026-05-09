/**
 * MCP tool implementations for session document management and conclusion.
 *
 * Tools:
 *   read_session_doc        — read the current doc content and version (auth required)
 *   update_session_doc      — full doc replace with optimistic concurrency (auth required)
 *   append_to_session_doc   — server-atomic append; no version token needed (auth required)
 *   update_session_metadata — update session title and/or description (auth required)
 *   conclude_session        — close the session, write Conclusion, broadcast (auth required)
 *
 * SERVER-ONLY — all helpers imported here write to or read from Postgres.
 *
 * SDK note (v1.29.0): server.tool() expects a raw ZodRawShapeCompat object
 * (i.e. a plain { key: ZodType } map) as the second argument, NOT a wrapped
 * z.object(...) instance. We define each schema as a z.object for type
 * inference then pass `.shape` to server.tool(). For schemas that use
 * .refine(), we keep a separate base schema to extract .shape from.
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

import { requireMembership } from "@/lib/mcp/auth";
import { MCPError } from "@/lib/mcp/errors";
import { broadcastSystemMessage } from "@/lib/mcp/broadcast";
import {
  getSessionById,
  touchParticipantHeartbeat,
  readSessionDoc,
  writeSessionDoc,
  appendToSessionDoc,
  closeSession,
} from "@/lib/mcp/repos";
import { db } from "@/lib/db/index";
import { sessions } from "@/db/schema";

// Shorthand alias matching what the SDK actually passes into tool callbacks.
type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// ---------------------------------------------------------------------------
// Helper: replace or append the ## Conclusion section in a doc
// ---------------------------------------------------------------------------

/**
 * If the doc already contains a `## Conclusion` heading at the start of a line,
 * everything from that heading through the end of the document is replaced by
 * `summary`. If no such heading exists, the summary is appended with separation.
 *
 * `summary` is expected to begin with `## Conclusion` but we are forgiving:
 * if it doesn't start with that heading, we prepend `## Conclusion\n\n`.
 */
function replaceOrAppendConclusion(doc: string, summary: string): string {
  // Normalise the summary to always start with ## Conclusion
  const normalisedSummary = /^## Conclusion(\r?\n|$)/.test(summary)
    ? summary
    : `## Conclusion\n\n${summary}`;

  // Match `## Conclusion` at the very start of any line (handles \r\n too)
  const headingRegex = /^## Conclusion(\r?\n|$)/m;

  if (headingRegex.test(doc)) {
    // Replace from the heading position through the end of the document
    return doc.replace(/^(## Conclusion)[\s\S]*$/m, normalisedSummary);
  }

  // No existing Conclusion section — append with blank-line separation
  const separator = doc.length > 0 && !doc.endsWith("\n\n") ? "\n\n" : "";
  return `${doc}${separator}${normalisedSummary}`;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const readSessionDocSchema = z.object({
  session_id: z.string().uuid(),
});

const updateSessionDocSchema = z.object({
  session_id: z.string().uuid(),
  content: z.string().min(1),
  expected_version: z.number().int().min(0),
});

const appendToSessionDocSchema = z.object({
  session_id: z.string().uuid(),
  text: z.string().min(1),
});

// Base shape for SDK registration (no .refine — refine returns ZodEffects, which has no .shape)
const updateSessionMetadataBase = z.object({
  session_id: z.string().uuid(),
  title: z.string().max(200).optional(),
  description: z.string().optional(),
  reason: z.string().min(1),
});

// Full schema with refinement — used only for runtime validation inside the handler
const updateSessionMetadataSchema = updateSessionMetadataBase.refine(
  (d) => d.title !== undefined || d.description !== undefined,
  { message: "must update title or description" },
);

type UpdateSessionMetadataInput = z.infer<typeof updateSessionMetadataBase>;

const concludeSessionSchema = z.object({
  session_id: z.string().uuid(),
  summary_section: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDocTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // read_session_doc
  // -------------------------------------------------------------------------
  // Returns the current markdown content and its version number; the version
  // is used by callers of update_session_doc for optimistic concurrency.
  server.tool(
    "read_session_doc",
    readSessionDocSchema.shape,
    async (
      input: z.infer<typeof readSessionDocSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id } = input;

      const participant = await requireMembership(extra, session_id);
      await touchParticipantHeartbeat(session_id, participant.teamId);

      const { content, version } = await readSessionDoc(session_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ content, version }),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // update_session_doc
  // -------------------------------------------------------------------------
  // Full replace with optimistic concurrency; returns the new version number.
  // Throws 409 Conflict if expected_version doesn't match current (bubbled from
  // writeSessionDoc); callers must re-read, merge, and retry on conflict.
  server.tool(
    "update_session_doc",
    updateSessionDocSchema.shape,
    async (
      input: z.infer<typeof updateSessionDocSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, content, expected_version } = input;

      const participant = await requireMembership(extra, session_id);
      await touchParticipantHeartbeat(session_id, participant.teamId);

      const session = await getSessionById(session_id);
      if (!session) throw new MCPError("not_found", "Session not found");
      if (session.status === "closed") {
        throw new MCPError(
          "forbidden",
          "Session is closed — document is read-only",
        );
      }

      const newVersion = await writeSessionDoc(
        session_id,
        content,
        expected_version,
        participant.teamId,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              version: newVersion,
              updated_at: new Date().toISOString(),
            }),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // append_to_session_doc
  // -------------------------------------------------------------------------
  // Server-atomic read+append+write; no version token needed from the caller.
  // Returns the new version after the append completes.
  server.tool(
    "append_to_session_doc",
    appendToSessionDocSchema.shape,
    async (
      input: z.infer<typeof appendToSessionDocSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, text } = input;

      const participant = await requireMembership(extra, session_id);
      await touchParticipantHeartbeat(session_id, participant.teamId);

      const session = await getSessionById(session_id);
      if (!session) throw new MCPError("not_found", "Session not found");
      if (session.status === "closed") {
        throw new MCPError(
          "forbidden",
          "Session is closed — document is read-only",
        );
      }

      const newVersion = await appendToSessionDoc(
        session_id,
        text,
        participant.teamId,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              version: newVersion,
              updated_at: new Date().toISOString(),
            }),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // update_session_metadata
  // -------------------------------------------------------------------------
  // Updates title and/or description on the session row; reason is required.
  // Broadcasts session_metadata_updated to the feed if any field actually changed.
  // The base shape is passed to server.tool(); refinement is enforced manually.
  server.tool(
    "update_session_metadata",
    updateSessionMetadataBase.shape,
    async (
      input: UpdateSessionMetadataInput,
      extra: HandlerExtra,
    ) => {
      const { session_id, title, description, reason } = input;

      // Enforce the at-least-one-of title/description refinement
      const parsed = updateSessionMetadataSchema.safeParse(input);
      if (!parsed.success) {
        throw new MCPError(
          "bad_request",
          parsed.error.errors[0]?.message ?? "must update title or description",
        );
      }

      const participant = await requireMembership(extra, session_id);
      await touchParticipantHeartbeat(session_id, participant.teamId);

      const session = await getSessionById(session_id);
      if (!session) throw new MCPError("not_found", "Session not found");
      if (session.status === "closed") {
        throw new MCPError(
          "forbidden",
          "Session is closed — metadata is read-only",
        );
      }

      // Build the changes object: only include fields that were supplied AND differ
      const changes: {
        title?: { from: string; to: string };
        description?: { from: string; to: string };
      } = {};

      const newTitle = title !== undefined ? title : session.title;
      const newDescription =
        description !== undefined ? description : session.description;

      if (title !== undefined && title !== session.title) {
        changes.title = { from: session.title, to: title };
      }
      if (description !== undefined && description !== session.description) {
        changes.description = { from: session.description, to: description };
      }

      // If nothing actually changed, treat as a successful no-op (no write/broadcast)
      const updatedAt = new Date();
      if (Object.keys(changes).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                title: session.title,
                description: session.description,
                updated_at: updatedAt.toISOString(),
              }),
            },
          ],
        };
      }

      // Write the updated values to the sessions row (last-write-wins — no version check)
      await db
        .update(sessions)
        .set({
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
        })
        .where(eq(sessions.id, session_id));

      // Broadcast to the feed so all polling teams see the change with the reason
      await broadcastSystemMessage(session_id, {
        event: "session_metadata_updated",
        by: participant.teamName,
        changes,
        reason,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              title: newTitle,
              description: newDescription,
              updated_at: updatedAt.toISOString(),
            }),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // conclude_session
  // -------------------------------------------------------------------------
  // Replaces or appends the ## Conclusion section in the doc, closes the session,
  // and broadcasts session_concluded. Idempotent — re-conclusion of a closed
  // session is permitted (replaces the existing Conclusion section).
  server.tool(
    "conclude_session",
    concludeSessionSchema.shape,
    async (
      input: z.infer<typeof concludeSessionSchema>,
      extra: HandlerExtra,
    ) => {
      const { session_id, summary_section } = input;

      const participant = await requireMembership(extra, session_id);
      await touchParticipantHeartbeat(session_id, participant.teamId);

      // Read the current doc; readSessionDoc throws not_found if session missing
      const { content: currentDoc, version: currentVersion } =
        await readSessionDoc(session_id);

      const newDoc = replaceOrAppendConclusion(currentDoc, summary_section);

      // Write the updated doc — attempt with current version; retry once on conflict
      let docVersion: number;
      try {
        docVersion = await writeSessionDoc(
          session_id,
          newDoc,
          currentVersion,
          participant.teamId,
        );
      } catch (err) {
        if (err instanceof MCPError && err.code === "conflict") {
          // Someone else wrote between our read and write — re-read and retry once
          const { content: retryDoc, version: retryVersion } =
            await readSessionDoc(session_id);
          const retryNewDoc = replaceOrAppendConclusion(
            retryDoc,
            summary_section,
          );
          docVersion = await writeSessionDoc(
            session_id,
            retryNewDoc,
            retryVersion,
            participant.teamId,
          );
        } else {
          throw err;
        }
      }

      // Close the session (sets status=closed + closedAt=NOW)
      const closedSession = await closeSession(session_id);

      // Broadcast the conclusion event so all polling teams receive session_closed signal
      await broadcastSystemMessage(session_id, {
        event: "session_concluded",
        by: participant.teamName,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              session_id,
              status: "closed",
              closed_at:
                closedSession.closedAt?.toISOString() ??
                new Date().toISOString(),
              doc_version: docVersion,
            }),
          },
        ],
      };
    },
  );
}
