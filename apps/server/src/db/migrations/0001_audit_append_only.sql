-- Audit events are append-only. Application code never updates or deletes them, and the
-- database refuses if anything tries (a bug, a bad migration, a person with psql).
CREATE OR REPLACE FUNCTION audit_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER audit_events_no_update_or_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();--> statement-breakpoint

-- Agent versions are immutable snapshots: a changed configuration is a new version row.
CREATE OR REPLACE FUNCTION agent_versions_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_versions rows are immutable; insert a new version instead'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER agent_versions_no_update
  BEFORE UPDATE ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION agent_versions_reject_update();
