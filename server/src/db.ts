import pg from 'pg'

export let pool: pg.Pool | null = null

export async function initDb(url: string) {
  pool = new pg.Pool({ connectionString: url, max: 10 })
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      domain_sid TEXT UNIQUE NOT NULL,
      principal TEXT NOT NULL,
      display_name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      principal_key TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (workspace_id, principal_key)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY,
      owner TEXT NOT NULL,
      title TEXT,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      local_thread_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `)
  await pool.query(`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS local_thread_id TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
    CREATE INDEX IF NOT EXISTS sessions_workspace_updated_idx ON sessions (workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages (session_id, created_at ASC);
  `)
}
