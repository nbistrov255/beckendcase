import express from "express";
import cors from "cors";
import crypto from "crypto";
import { initDB } from "./database";

// --- КОНФИГУРАЦИЯ ---
const PORT = 3000;
const RIGA_TZ = "Europe/Riga";

const app = express();
app.use(cors());
app.use(express.json());

let db: any = null;

// --- HELPERS ---
function rigaDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: RIGA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return { y, m, d };
}
function getRigaDayKey() { const { y, m, d } = rigaDateParts(); return `${y}-${m}-${d}`; }
function getRigaMonthKey() { const { y, m } = rigaDateParts(); return `${y}-${m}`; }

function normalizeDatePart(createdAt: string): string | null {
  if (!createdAt) return null;
  const s = String(createdAt).trim();
  const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2 = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
  return null;
}

// --- SMARTSHELL & AUTH ---
async function gqlRequest<T>(query: string, variables: any = {}, token?: string): Promise<T> {
  const url = process.env.SMARTSHELL_API_URL || "https://billing.smartshell.gg/api/graphql";
  const headers: any = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  const json = await res.json() as any;
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

let _serviceToken: string | null = null;
let _serviceTokenExp = 0;
async function getServiceToken(): Promise<string> {
  if (_serviceToken && Date.now() < _serviceTokenExp) return _serviceToken;
  const data = await gqlRequest<{ login: { access_token: string, expires_in: number } }>(`
    mutation Login($input: LoginInput!) { login(input: $input) { access_token expires_in } }
  `, { input: { login: process.env.SMARTSHELL_LOGIN, password: process.env.SMARTSHELL_PASSWORD, company_id: Number(process.env.SMARTSHELL_CLUB_ID) } });
  _serviceToken = data.login.access_token;
  _serviceTokenExp = Date.now() + (data.login.expires_in - 60) * 1000;
  return _serviceToken;
}

async function calculateProgress(userUuid: string) {
  const token = await getServiceToken();
  const data = await gqlRequest<any>(`
    query GetPayments($uuid: String!) { getPaymentsByClientId(uuid: $uuid, page: 1, first: 100) { data { created_at title sum amount is_refunded items { type } } } }
  `, { uuid: userUuid }, token);
  const items = data.getPaymentsByClientId?.data || [];
  let daily = 0, monthly = 0;
  const todayKey = getRigaDayKey();
  const monthKey = getRigaMonthKey();

  for (const p of items) {
    const isDeposit = p.items?.some((i: any) => i.type === "DEPOSIT") || String(p.title).toLowerCase().includes("пополнение");
    if (!isDeposit || p.is_refunded) continue;
    const val = Number(p.sum) || Number(p.amount) || 0;
    if (val <= 0) continue;
    const dateStr = normalizeDatePart(p.created_at);
    if (!dateStr) continue;
    if (dateStr === todayKey) daily += val;
    if (dateStr.startsWith(monthKey)) monthly += val;
  }
  return { daily: Math.round(daily * 100) / 100, monthly: Math.round(monthly * 100) / 100 };
}

// Middleware
async function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  const session = await db.get("SELECT * FROM sessions WHERE token = ?", token);
  if (!session) return res.status(401).json({ error: "Invalid session" });
  res.locals.session = session;
  next();
}

// === PUBLIC ROUTES ===

// Live Feed (последние выигрыши)
app.get("/api/stats/live", async (req, res) => {
  try {
    const spins = await db.all(`
      SELECT s.prize_title, s.prize_amount_eur, s.created_at, u.nickname 
      FROM spins s
      JOIN sessions u ON s.user_uuid = u.user_uuid
      ORDER BY s.created_at DESC LIMIT 10
    `);
    res.json({ spins });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// === ADMIN ROUTES ===
app.post("/api/admin/items", async (req, res) => {
  try {
    const { id, type, title, image_url, price_eur, sell_price_eur } = req.body;
    const newItemId = id || crypto.randomUUID();
    await db.run(`
      INSERT INTO items (id, type, title, image_url, price_eur, sell_price_eur) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET type=excluded.type, title=excluded.title, image_url=excluded.image_url, price_eur=excluded.price_eur, sell_price_eur=excluded.sell_price_eur
    `, newItemId, type, title, image_url, price_eur, sell_price_eur);
    res.json({ success: true, item_id: newItemId });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/items", async (req, res) => {
  const items = await db.all("SELECT * FROM items WHERE is_active = 1 ORDER BY title ASC");
  res.json({ success: true, items });
});

app.post("/api/admin/cases", async (req, res) => {
  try {
    const { id, title, type, threshold_eur, image_url, items } = req.body;
    await db.run("BEGIN TRANSACTION");
    await db.run(`
      INSERT INTO cases (id, title, type, threshold_eur, image_url) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, type=excluded.type, threshold_eur=excluded.threshold_eur, image_url=excluded.image_url
    `, id, title, type, threshold_eur, image_url);
    await db.run("DELETE FROM case_items WHERE case_id = ?", id);
    if (items && Array.isArray(items)) {
      for (const item of items) {
        await db.run(`INSERT INTO case_items (case_id, item_id, weight, rarity) VALUES (?, ?, ?, ?)`, id, item.item_id, item.weight, item.rarity);
      }
    }
    await db.run("COMMIT");
    res.json({ success: true, case_id: id });
  } catch (e: any) { await db.run("ROLLBACK"); res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/cases", async (req, res) => {
  const cases = await db.all("SELECT * FROM cases WHERE is_active = 1");
  res.json({ success: true, cases });
});

// === CLIENT ROUTES ===

app.post("/api/auth/session", async (req, res) => {
  try {
    const { login, password } = req.body;
    const authData = await gqlRequest<{ clientLogin: { access_token: string } }>(`
      mutation CL($i: ClientLoginInput!) { clientLogin(input: $i) { access_token } }
    `, { i: { login, password } });
    const clientToken = authData.clientLogin.access_token;
    const meData = await gqlRequest<{ clientMe: { uuid: string, nickname: string } }>(`
      query { clientMe { uuid nickname } }
    `, {}, clientToken);
    const { uuid, nickname } = meData.clientMe;
    const sessionToken = crypto.randomUUID();
    const now = Date.now();
    await db.run(`
      INSERT INTO sessions (token, user_uuid, nickname, created_at, last_seen_at, expires_at, client_access_token)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(token) DO NOTHING
    `, sessionToken, uuid, nickname, now, now, now + 86400000, clientToken);
    res.json({ success: true, session_token: sessionToken, user: { uuid, nickname } });
  } catch (e: any) { res.status(401).json({ success: false, error: "Auth failed" }); }
});

app.get("/api/me", requireSession, async (req, res) => {
  const { user_uuid, nickname } = res.locals.session;
  const { daily, monthly } = await calculateProgress(user_uuid);
  const todayKey = getRigaDayKey();
  const monthKey = getRigaMonthKey();
  const casesDB = await db.all("SELECT * FROM cases WHERE is_active = 1");
  const claims = await db.all(`SELECT case_id FROM case_claims WHERE user_uuid = ? AND (period_key = ? OR period_key = ?)`, user_uuid, todayKey, monthKey);
  const claimedIds = new Set(claims.map((c: any) => c.case_id));
  const cases = casesDB.map((cfg: any) => {
    const current = cfg.type === "daily" ? daily : monthly;
    const isClaimed = claimedIds.has(cfg.id);
    return { ...cfg, progress: current, available: current >= cfg.threshold_eur && !isClaimed, is_claimed: isClaimed };
  });
  const nowTs = Math.floor(Date.now() / 1000);
  res.json({
    uuid: user_uuid, nickname,
    progress: { daily_topup_eur: daily, monthly_topup_eur: monthly },
    timers: { daily_reset_seconds: 86400 - (nowTs % 86400), monthly_reset_seconds: 86400 * 30 },
    cases
  });
});

app.get("/api/inventory", requireSession, async (req, res) => {
  const { user_uuid } = res.locals.session;
  const items = await db.all("SELECT * FROM inventory WHERE user_uuid = ? AND status = 'PENDING' ORDER BY created_at DESC", user_uuid);
  res.json({ items });
});

app.post("/api/inventory/sell", requireSession, async (req, res) => {
  try {
    const { user_uuid } = res.locals.session;
    const { inventory_id } = req.body;
    const item = await db.get("SELECT * FROM inventory WHERE id = ? AND user_uuid = ?", inventory_id, user_uuid);
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.status !== "PENDING") return res.status(400).json({ error: "Already sold" });
    if (item.type === "money") return res.status(400).json({ error: "Cannot sell money" });
    await db.run("UPDATE inventory SET status = 'SOLD', updated_at = ? WHERE id = ?", Date.now(), inventory_id);
    res.json({ success: true, sold_amount: item.sell_price_eur });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/cases/open", requireSession, async (req, res) => {
  try {
    const { user_uuid, nickname } = res.locals.session; // Берём ник из сессии для логов
    const { case_id } = req.body;
    const caseMeta = await db.get("SELECT * FROM cases WHERE id = ?", case_id);
    if (!caseMeta) return res.status(404).json({ error: "Case not found" });
    const periodKey = caseMeta.type === "daily" ? getRigaDayKey() : getRigaMonthKey();
    const existing = await db.get("SELECT id FROM case_claims WHERE user_uuid=? AND case_id=? AND period_key=?", user_uuid, case_id, periodKey);
    if (existing) return res.status(400).json({ error: "Already opened in this period" });
    const { daily, monthly } = await calculateProgress(user_uuid);
    const balance = caseMeta.type === "daily" ? daily : monthly;
    if (balance < caseMeta.threshold_eur) return res.status(403).json({ error: "Not enough deposit" });
    const caseItems = await db.all("SELECT * FROM case_items WHERE case_id = ?", case_id);
    if (caseItems.length === 0) return res.status(500).json({ error: "Case is empty!" });
    
    const totalWeight = caseItems.reduce((acc: number, item: any) => acc + item.weight, 0);
    let rnd = Math.random() * totalWeight;
    let selectedLink = caseItems[0];
    for (const link of caseItems) { rnd -= link.weight; if (rnd <= 0) { selectedLink = link; break; } }
    
    const prizeItem = await db.get("SELECT * FROM items WHERE id = ?", selectedLink.item_id);
    if (!prizeItem) return res.status(500).json({ error: "Prize item data missing" });

    await db.run("BEGIN TRANSACTION");
    await db.run("INSERT INTO case_claims (user_uuid, case_id, period_key, claimed_at) VALUES (?, ?, ?, ?)", user_uuid, case_id, periodKey, Date.now());
    await db.run(`INSERT INTO spins (user_uuid, case_id, period_key, prize_title, prize_amount_eur, created_at) VALUES (?, ?, ?, ?, ?, ?)`, user_uuid, case_id, periodKey, prizeItem.title, prizeItem.price_eur, Date.now());
    const invRes = await db.run(`INSERT INTO inventory (user_uuid, item_id, title, type, image_url, amount_eur, sell_price_eur, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`, user_uuid, prizeItem.id, prizeItem.title, prizeItem.type, prizeItem.image_url, prizeItem.price_eur, prizeItem.sell_price_eur, Date.now(), Date.now());
    if (prizeItem.type === 'money') { await db.run("UPDATE inventory SET status = 'CREDITED' WHERE id = ?", invRes.lastID); }
    await db.run("COMMIT");

    res.json({ success: true, prize: { title: prizeItem.title, image: prizeItem.image_url, type: prizeItem.type, rarity: selectedLink.rarity, value: prizeItem.price_eur } });
  } catch (e: any) { await db.run("ROLLBACK"); res.status(500).json({ error: e.message }); }
});

initDB().then(database => {
  db = database;
  app.listen(PORT, "0.0.0.0", () => console.log(`[Backend] Started on port ${PORT}`));
});