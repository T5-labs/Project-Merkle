CREATE TYPE "public"."message_type" AS ENUM('chat', 'system');--> statement-breakpoint
CREATE TYPE "public"."participant_status" AS ENUM('active', 'idle', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"posted_by_team_id" uuid,
	"type" "message_type" NOT NULL,
	"content" jsonb NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sequence" bigserial NOT NULL,
	"attachments" jsonb
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"session_id" uuid NOT NULL,
	"team_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"team_name" varchar(200) NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "participant_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "participants_session_id_team_id_pk" PRIMARY KEY("session_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "session_doc_history" (
	"session_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"written_by_team_id" uuid NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_doc_history_session_id_version_pk" PRIMARY KEY("session_id","version")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"session_doc_title" varchar(255),
	"session_doc" text DEFAULT '' NOT NULL,
	"session_doc_version" integer DEFAULT 0 NOT NULL,
	"created_by_team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"status" "session_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_doc_history" ADD CONSTRAINT "session_doc_history_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_session_sequence_idx" ON "messages" USING btree ("session_id","sequence");