-- identity v8 (Better Auth): the tables, ADDED NEXT TO the v7 ones. Nothing reads or writes them yet.
--
-- WHAT THIS IS. rova will move from @quynhonsemiconductor/identity 7.x to 8.x (the identity v8 plan, §8.5). The
-- cutover is a code change plus a data backfill; THIS migration is only the schema, shipped ahead of both so it is on
-- every environment, deployed and soaked, before any code depends on it. The v8 tables sit in the same `identity`
-- schema as rova's own tables, under Better Auth's own SINGULAR names:
--
--     identity.users            rova's profile table (v7, KEPT: status, locale, timezone, phone, last_login_at, deleted_at)
--     identity."user"           Better Auth's login identity (v8)      same id, one-to-one, linked by value, no FK
--     identity.session          v8 sessions (+ context_id, identity 8.4: the active workspace)
--     identity.account          the Microsoft identity of a user (provider_id 'microsoft', account_id = the Entra oid)
--     identity.verification     Better Auth's short-lived tokens (OAuth state)
--
-- ADDITIVE ONLY. Four CREATE TABLEs and their indexes. No existing table is altered, locked or read; the migration
-- cannot change what v7 does. The mapping that fills these tables at cutover is db/identity-v8/backfill.sql, which is
-- NOT run by this migration (docs/runbooks/identity-v8-data-model.md). CLAUDE.md says a schema change over existing
-- rows backfills in the same migration; this is the deliberate exception, because nothing uses the new tables yet and
-- a backfill run now would be stale by the cutover and would have to be re-run anyway.
--
-- ROLLBACK. db/identity-v8/rollback.sql drops exactly these four tables and the migration record, refusing if they
-- hold rows. No v7 object is involved.
--
-- Shape: `auth generate` for the `staff` preset (staff.allowGuests) + the admin plugin + the 8.4 session context, then the
-- house adjustments: `identity` schema, uuid ids with no database default (identity generates uuidv7 in the application),
-- timestamptz. No organization / member / sso_provider / invitation / two_factor tables: those belong to presets rova does
-- not run (partner SSO is deferred). Privileges come from the schema's default privileges (migration 0068), as for every
-- table created since.
CREATE TABLE "identity"."user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "identity"."session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"impersonated_by" uuid,
	"context_id" uuid,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "identity"."account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "identity"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "identity"."session" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "identity"."account" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "identity"."verification" USING btree ("identifier");
--> statement-breakpoint
COMMENT ON TABLE "identity"."user" IS 'identity v8 (Better Auth) login identity. UNUSED until the cutover. identity.users stays the profile table; the two share ids, one-to-one, no FK (migration 0136).';
--> statement-breakpoint
COMMENT ON COLUMN "identity"."session"."context_id" IS 'identity 8.4: the active workspace of the session. Written only by identity (context/set); not a foreign key.';
