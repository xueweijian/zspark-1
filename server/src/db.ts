import pg from 'pg'

export let pool: pg.Pool | null = null

const MIGRATIONS = [
  {
    id: 1,
    name: 'initial_collab_schema',
    sql: `
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
      CREATE TABLE IF NOT EXISTS artifacts (
        id UUID PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        local_path TEXT,
        turn_id TEXT,
        storage_path TEXT,
        content BYTEA,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `
  },
  {
    id: 2,
    name: 'workspace_session_artifact_indexes',
    sql: `
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS local_thread_id TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
      CREATE INDEX IF NOT EXISTS sessions_workspace_updated_idx ON sessions (workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages (session_id, created_at ASC);
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_path TEXT;
      ALTER TABLE artifacts ALTER COLUMN content DROP NOT NULL;
      CREATE INDEX IF NOT EXISTS artifacts_session_created_idx ON artifacts (workspace_id, session_id, created_at DESC);
    `
  }
]

export async function initDb(url: string) {
  pool = new pg.Pool({ connectionString: url, max: 10 })
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now()
    );
  `)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE')
    for (const migration of MIGRATIONS) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1 LIMIT 1', [migration.id])
      if (applied.rowCount) continue
      await client.query(migration.sql)
      await client.query(
        'INSERT INTO schema_migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        [migration.id, migration.name]
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
