-- Drop all legacy data before adding the NOT NULL column.
-- FK order: session_doc_history → messages → participants → sessions
DELETE FROM "session_doc_history";
DELETE FROM "messages";
DELETE FROM "participants";
DELETE FROM "sessions";
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "passcode_hash" text NOT NULL;