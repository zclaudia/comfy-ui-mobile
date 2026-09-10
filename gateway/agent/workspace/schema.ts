import type { DatabaseSync } from 'node:sqlite';

/** Additive until the migration is explicitly committed. Original tables remain available for audit/rollback. */
export function createWorkspaceSchema(db: DatabaseSync) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS task_session_identity ON tasks(session_id, id);
    CREATE TABLE IF NOT EXISTS workspace_migrations(version INTEGER PRIMARY KEY, completed INTEGER NOT NULL, report TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_sessions(
      id TEXT PRIMARY KEY REFERENCES sessions(id), data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE TABLE IF NOT EXISTS drafts(
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id), head_revision INTEGER NOT NULL CHECK(head_revision>=0),
      data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(session_id,id)
    );
    CREATE INDEX IF NOT EXISTS draft_session ON drafts(session_id,ordinal);
    CREATE TABLE IF NOT EXISTS draft_revisions(
      draft_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), session_id TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(draft_id,revision),
      FOREIGN KEY(session_id,draft_id) REFERENCES drafts(session_id,id)
    );
    CREATE TABLE IF NOT EXISTS revision_assets(
      session_id TEXT NOT NULL, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
      binding_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      PRIMARY KEY(draft_id,revision,binding_id),
      FOREIGN KEY(draft_id,revision) REFERENCES draft_revisions(draft_id,revision),
      FOREIGN KEY(session_id,draft_id) REFERENCES drafts(session_id,id),
      FOREIGN KEY(session_id,asset_id) REFERENCES assets(session_id,id)
    );
    CREATE TABLE IF NOT EXISTS workspace_operations(
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
      task_id TEXT NOT NULL, step_key TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(task_id,step_key), UNIQUE(session_id,id),
      FOREIGN KEY(session_id,task_id) REFERENCES tasks(session_id,id)
    );
    CREATE TABLE IF NOT EXISTS runs(
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
      task_id TEXT, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
      submission_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(session_id,id), FOREIGN KEY(session_id,draft_id) REFERENCES drafts(session_id,id),
      FOREIGN KEY(draft_id,revision) REFERENCES draft_revisions(draft_id,revision),
      FOREIGN KEY(session_id,task_id) REFERENCES tasks(session_id,id)
    );
    CREATE INDEX IF NOT EXISTS run_session ON runs(session_id,ordinal);
    CREATE INDEX IF NOT EXISTS run_state ON runs(state);
    CREATE UNIQUE INDEX IF NOT EXISTS run_task_active ON runs(task_id)
      WHERE task_id IS NOT NULL AND state IN ('preparing','awaiting_approval','submitting','reconciling','queued','running');
    CREATE TABLE IF NOT EXISTS assets(
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id),
      source_run_id TEXT, output_locator TEXT, kind TEXT NOT NULL, capture_state TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(source_run_id,output_locator), UNIQUE(session_id,id),
      FOREIGN KEY(session_id,source_run_id) REFERENCES runs(session_id,id)
    );
    CREATE INDEX IF NOT EXISTS asset_session ON assets(session_id,ordinal);
    CREATE INDEX IF NOT EXISTS asset_capture ON assets(capture_state);
    CREATE TABLE IF NOT EXISTS run_inputs(
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, binding_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      PRIMARY KEY(run_id,binding_id), FOREIGN KEY(session_id,run_id) REFERENCES runs(session_id,id),
      FOREIGN KEY(session_id,asset_id) REFERENCES assets(session_id,id)
    );
    CREATE TABLE IF NOT EXISTS asset_locations(
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), server_id TEXT NOT NULL,
      role TEXT NOT NULL, ref_key TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(asset_id,server_id,role,ref_key)
    );
    CREATE TABLE IF NOT EXISTS asset_materializations(
      asset_id TEXT NOT NULL REFERENCES assets(id), blob_digest TEXT NOT NULL, server_id TEXT NOT NULL,
      loader_kind TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      PRIMARY KEY(asset_id,blob_digest,server_id,loader_kind)
    );
    CREATE TABLE IF NOT EXISTS workspace_requests(
      session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
      digest TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(session_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS workspace_request_cancellations(
      session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
      digest TEXT NOT NULL, PRIMARY KEY(session_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS workspace_cleanup_ops(
      session_id TEXT PRIMARY KEY REFERENCES sessions(id), request_id TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE TABLE IF NOT EXISTS asset_upload_requests(
      session_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, asset_id TEXT NOT NULL,
      PRIMARY KEY(session_id,request_id), FOREIGN KEY(session_id,asset_id) REFERENCES assets(session_id,id)
    );
    CREATE TABLE IF NOT EXISTS workspace_selections(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      FOREIGN KEY(session_id,task_id) REFERENCES tasks(session_id,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS selection_request ON workspace_selections(task_id,json_extract(data,'$.requestId'));
    CREATE UNIQUE INDEX IF NOT EXISTS selection_pending ON workspace_selections(task_id) WHERE json_extract(data,'$.state')='pending';
    CREATE TABLE IF NOT EXISTS library_save_ops(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
      state TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      FOREIGN KEY(session_id,draft_id) REFERENCES drafts(session_id,id),
      FOREIGN KEY(draft_id,revision) REFERENCES draft_revisions(draft_id,revision)
    );
    CREATE TABLE IF NOT EXISTS library_asset_refs(
      server_id TEXT NOT NULL, workflow_id TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
      blob_digest TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      PRIMARY KEY(server_id,workflow_id,asset_id,blob_digest)
    );
    CREATE TABLE IF NOT EXISTS legacy_workspace_refs(
      session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, legacy_key TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(session_id,kind,legacy_key)
    );
    CREATE TRIGGER IF NOT EXISTS immutable_draft_revision BEFORE UPDATE ON draft_revisions
      BEGIN SELECT RAISE(ABORT, 'Workflow revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_asset_content BEFORE UPDATE ON assets
      WHEN json_extract(OLD.data,'$.blobDigest') IS NOT NULL
        AND json_extract(NEW.data,'$.blobDigest') IS NOT json_extract(OLD.data,'$.blobDigest')
      BEGIN SELECT RAISE(ABORT, 'Asset content is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_submitted_snapshot BEFORE UPDATE ON runs
      WHEN OLD.state NOT IN ('preparing','awaiting_approval') AND (
        json_extract(NEW.data,'$.executionSnapshot') IS NOT json_extract(OLD.data,'$.executionSnapshot') OR
        json_extract(NEW.data,'$.inputManifest') IS NOT json_extract(OLD.data,'$.inputManifest'))
      BEGIN SELECT RAISE(ABORT, 'Submitted execution snapshot is immutable'); END;
  `);
}
