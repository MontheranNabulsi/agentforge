CREATE TABLE "blobs" (
	"key" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "approver_roles" jsonb DEFAULT '[]'::jsonb NOT NULL;