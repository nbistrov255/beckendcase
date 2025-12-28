import sqlite3 from 'sqlite3'
import { open } from 'sqlite'

export async function initDB() {
  const db = await open({
    filename: './cyberhub.db',
    driver: sqlite3.Database
  })

  await db.exec('PRAGMA foreign_keys = ON;')

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_uuid TEXT,
      nickname TEXT,
      created_at INTEGER,
      last_seen_at INTEGER,
      expires_at INTEGER,
      client_access_token TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      type TEXT,
      title TEXT,
      image_url TEXT,
      price_eur REAL,
      sell_price_eur REAL,
      rarity TEXT,
      stock INTEGER DEFAULT -1, -- -1 значит бесконечно, 0 и больше - лимит
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      title TEXT,
      type TEXT,
      threshold_eur REAL,
      image_url TEXT,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS case_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT,
      item_id TEXT,
      weight REAL,
      rarity TEXT,
      FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS case_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT,
      case_id TEXT,
      period_key TEXT,
      claimed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT,
      case_id TEXT,
      period_key TEXT,
      prize_title TEXT,
      prize_amount_eur REAL,
      rarity TEXT,
      image_url TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT,
      item_id TEXT,
      title TEXT,
      type TEXT,
      image_url TEXT,
      amount_eur REAL,
      sell_price_eur REAL,
      rarity TEXT,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
  `)

  // Миграции
  try { await db.exec("ALTER TABLE items ADD COLUMN rarity TEXT;"); } catch (e) {}
  try { await db.exec("ALTER TABLE items ADD COLUMN stock INTEGER DEFAULT -1;"); } catch (e) {}
  try { await db.exec("ALTER TABLE spins ADD COLUMN rarity TEXT;"); } catch (e) {}
  try { await db.exec("ALTER TABLE spins ADD COLUMN image_url TEXT;"); } catch (e) {}
  try { await db.exec("ALTER TABLE inventory ADD COLUMN rarity TEXT;"); } catch (e) {}

  return db
}