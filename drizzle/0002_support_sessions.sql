ALTER TABLE "sessions" ADD COLUMN "is_support_session" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "selected_ticket_key" varchar(128);--> statement-breakpoint
CREATE TABLE "support_ticket_options" (
	"session_id" uuid NOT NULL,
	"ticket_key" varchar(128) NOT NULL,
	"project" varchar(64) NOT NULL,
	"number" varchar(64) NOT NULL,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_by_team_id" uuid NOT NULL,
	CONSTRAINT "support_ticket_options_session_id_ticket_key_pk" PRIMARY KEY("session_id","ticket_key")
);
--> statement-breakpoint
ALTER TABLE "support_ticket_options" ADD CONSTRAINT "support_ticket_options_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_ticket_options_session_idx" ON "support_ticket_options" USING btree ("session_id");