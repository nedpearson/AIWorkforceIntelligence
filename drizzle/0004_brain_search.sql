ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("heading", '') || ' ' || "text")) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kchunks_tsv" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE "brain_facts" ADD COLUMN IF NOT EXISTS "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', "subject" || ' ' || "statement")) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "facts_tsv" ON "brain_facts" USING gin ("tsv");
