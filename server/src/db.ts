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
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY,
      owner TEXT NOT NULL,
      title TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `)
}
