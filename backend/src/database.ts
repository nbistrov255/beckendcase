import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";

export async function initDB(): Promise<Database> {
  const db = await open({
    filename: "./cyberhub.db",
    driver: sqlite3.Database,
  });

  // === Таблица учёта открытых кейсов (анти-повтор) ===
  await db.exec(`
    CREATE TABLE IF NOT EXISTS case_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      case_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_case_claims_user_case_period
      ON case_claims(user_uuid, case_id, claimed_at);
  `);

  // === Логи открытий (spin) ===
  await db.exec(`
    CREATE TABLE IF NOT EXISTS spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      case_id TEXT NOT NULL,
      period_key TEXT NOT NULL,

      prize_type TEXT NOT NULL,
      prize_title TEXT NOT NULL,
      prize_amount_eur REAL,
      prize_meta_json TEXT,

      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_spins_user_uuid ON spins(user_uuid);
    CREATE INDEX IF NOT EXISTS idx_spins_created_at ON spins(created_at);
  `);

  // === Inventory (выигранные призы) ===
  await db.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      spin_id INTEGER NOT NULL,

      prize_type TEXT NOT NULL,
      title TEXT NOT NULL,
      amount_eur REAL,
      meta_json TEXT,

      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      FOREIGN KEY (spin_id) REFERENCES spins(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_user_uuid ON inventory(user_uuid);
    CREATE INDEX IF NOT EXISTS idx_inventory_created_at ON inventory(created_at);
  `);

  // === Таблица сессий фронтенда ===
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_uuid TEXT NOT NULL,
      nickname TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,

      client_access_token TEXT,
      client_refresh_token TEXT,
      client_token_expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_uuid ON sessions(user_uuid);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);

  // === Миграции для старых баз ===
  const cols: Array<{ name: string }> = await db.all(`PRAGMA table_info(sessions)`);
  const has = (name: string) => cols.some((c) => c.name === name);

  if (!has("client_access_token")) {
    await db.exec(`ALTER TABLE sessions ADD COLUMN client_access_token TEXT;`);
  }
  if (!has("client_refresh_token")) {
    await db.exec(`ALTER TABLE sessions ADD COLUMN client_refresh_token TEXT;`);
  }
  if (!has("client_token_expires_at")) {
    await db.exec(`ALTER TABLE sessions ADD COLUMN client_token_expires_at INTEGER;`);
  }

  console.log("[DB] SQLite initialized and tables ready");
  return db;
}
