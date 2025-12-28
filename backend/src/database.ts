import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import path from "path";

export async function initDB(): Promise<Database> {
  const dbPath = path.join(__dirname, "../cyberhub.db");
  
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  console.log(`[DB] Connected to SQLite at ${dbPath}`);

  // 1. Сессии
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_uuid TEXT NOT NULL,
      nickname TEXT,
      created_at INTEGER,
      last_seen_at INTEGER,
      expires_at INTEGER,
      client_access_token TEXT
    )
  `);

  // 2. ТОВАРЫ (Items) - Создаются в Админке
  await db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,        -- 'skin', 'physical', 'money'
      title TEXT NOT NULL,
      image_url TEXT,
      price_eur REAL,            -- Отображаемая цена
      sell_price_eur REAL,       -- Цена продажи
      is_active INTEGER DEFAULT 1
    )
  `);

  // 3. КЕЙСЫ (Cases) - Создаются в Админке
  await db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,       -- 'daily_3', 'monthly_50' и т.д.
      title TEXT NOT NULL,
      type TEXT NOT NULL,        -- 'daily', 'monthly'
      threshold_eur REAL NOT NULL,
      image_url TEXT,
      is_active INTEGER DEFAULT 1
    )
  `);

  // 4. СОДЕРЖИМОЕ КЕЙСОВ (Связь)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS case_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      weight INTEGER NOT NULL,
      rarity TEXT DEFAULT 'common'
    )
  `);

  // 5. АНТИ-ФРОД (Клеймы)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS case_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      case_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      claimed_at INTEGER,
      UNIQUE(user_uuid, case_id, period_key)
    )
  `);

  // 6. ИНВЕНТАРЬ (Inventory)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      item_id TEXT,
      title TEXT,
      type TEXT,
      image_url TEXT,
      amount_eur REAL,
      sell_price_eur REAL,
      status TEXT DEFAULT 'PENDING', -- 'PENDING', 'SOLD', 'CREDITED'
      created_at INTEGER,
      updated_at INTEGER
    )
  `);

  // 7. СПИНЫ (История)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_uuid TEXT NOT NULL,
      case_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      prize_title TEXT,
      prize_amount_eur REAL,
      created_at INTEGER
    )
  `);

  return db;
}