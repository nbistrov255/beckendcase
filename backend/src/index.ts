import express from "express";
import cors from "cors";
import crypto from "crypto";
import { initDB } from "./database";

// --- КОНФИГУРАЦИЯ ---
const PORT = 3000;
const RIGA_TZ = "Europe/Riga";

if (!process.env.SMARTSHELL_LOGIN) console.error("❌ ERROR: SMARTSHELL_LOGIN is missing");
if (!process.env.SMARTSHELL_PASSWORD) console.error("❌ ERROR: SMARTSHELL_PASSWORD is missing");
if (!process.env.SMARTSHELL_CLUB_ID) console.error("❌ ERROR: SMARTSHELL_CLUB_ID is missing");

const app = express();
app.use(cors());
app.use(express.json());

let db: any = null;

// --- HELPERS ---
function rigaDateParts(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: RIGA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    return { y, m, d };
  } catch (e) {
    const d = new Date(now.getTime() + (3 * 3600 * 1000));
    return { y: d.getUTCFullYear().toString(), m: (d.getUTCMonth() + 1).toString().padStart(2, '0'), d: d.getUTCDate().toString().padStart(2, '0') };
  }
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

// --- SMARTSHELL ---
async function gqlRequest<T>(query: string, variables: any = {}, token?: string): Promise<T> {
  const url = process.env.SMARTSHELL_API_URL || "https://billing.smartshell.gg/api/graphql";
  const headers: any = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    if (!res.ok) {
        const text = await res.text();
        console.error(`SmartShell HTTP ${res.status}:`, text);
        throw new Error(`SmartShell HTTP Error: ${res.status}`);
    }
    const json = await res.json() as any;
    if (json.errors) {
      console.error("GQL Errors:", JSON.stringify(json.errors));
      throw new Error(`SmartShell API Error: ${json.errors[0]?.message}`);
    }
    return json.data;
  } catch (e) {
    console.error("Fetch Error:", e);
    throw e;
  }
}

let _serviceToken: string | null = null;
let _serviceTokenExp = 0;
async function getServiceToken(): Promise<string> {
  if (_serviceToken && Date.now() < _serviceTokenExp) return _serviceToken;
  try {
    const data = await gqlRequest<{ login: { access_token: string, expires_in: number } }>(`
      mutation Login($input: LoginInput!) { login(input: $input) { access_token expires_in } }
    `, { input: { login: process.env.SMARTSHELL_LOGIN, password: process.env.SMARTSHELL_PASSWORD, company_id: Number(process.env.SMARTSHELL_CLUB_ID) } });
    _serviceToken = data.login.access_token;
    _serviceTokenExp = Date.now() + (data.login.expires_in - 60) * 1000;
    return _serviceToken;
  } catch (e) { console.error("Admin Login Failed"); throw e; }
}

// --- БАЛАНС (МЕТОД ПЕРЕБОРА) ---
async function getClientBalance(userUuid: string): Promise<number> {
  try {
    const token = await getServiceToken();
    // Запрашиваем просто список клиентов без фильтров (первую страницу)
    const data = await gqlRequest<{ clients: { data: { uuid: string, balance: number }[] } }>(`
      query GetAllClients {
        clients {
          data { uuid balance }
        }
      }
    `, {}, token);
    
    // Ищем нашего клиента в списке вручную
    const client = data.clients?.data?.find(c => c.uuid === userUuid);
    
    if (client) {
        console.log(`💰 Found Balance for ${userUuid}: ${client.balance} EUR`);
        return client.balance;
    } else {
        console.warn(`⚠️ Client ${userUuid} not found in the first batch of 'clients'. Balance set to 0.`);
        return 0;
    }
  } catch (e) {
    console.error(`⚠️ Failed to fetch balance loop:`, e);
    return 0;
  }
}

async function calculateProgressSafe(userUuid: string) {
  try {
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
  } catch (e) { return { daily: 0, monthly: 0 }; }
}

async function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  if (!db) return res.status(500).json({ error: "DB not ready" });
  const session = await db.get("SELECT * FROM sessions WHERE token = ?", token);
  if (!session) return res.status(401).json({ error: "Invalid session" });
  await db.run("UPDATE sessions SET last_seen_at = ? WHERE token = ?", Date.now(), token);
  res.locals.session = session;
  next();
}

// === ROUTES ===
app.get("/api/stats/public", async (req, res) => {
    try {
        const playersResult = await db.get("SELECT COUNT(DISTINCT user_uuid) as count FROM sessions");
        const casesResult = await db.get("SELECT COUNT(*) as count FROM spins");
        res.json({ uniquePlayers: playersResult?.count || 0, casesOpened: casesResult?.count || 0 });
    } catch (e: any) { res.json({ uniquePlayers: 0, casesOpened: 0 }); }
});

app.get("/api/drops/recent", async (req, res) => {
  try {
    const spins = await db.all(`SELECT s.id, s.prize_title as item_name, s.image_url as image, s.rarity, s.created_at as timestamp, u.nickname as user_name FROM spins s LEFT JOIN sessions u ON s.user_uuid = u.user_uuid ORDER BY s.created_at DESC LIMIT 20`);
    const drops = spins.map((s: any) => ({ ...s, rarity: s.rarity || 'common', image: s.image || 'https://via.placeholder.com/150' }));
    res.json({ success: true, drops });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- ITEMS (ИСПРАВЛЕНО ОТОБРАЖЕНИЕ) ---
app.post("/api/admin/items", async (req, res) => {
  console.log("📦 [ADD ITEM]", req.body);
  try {
    let { id, type, title, image_url, price_eur, sell_price_eur, rarity, stock } = req.body;
    if (!sell_price_eur) sell_price_eur = price_eur;
    if (!rarity) rarity = 'common';
    if (stock === undefined || stock === '') stock = -1;
    const newItemId = id || crypto.randomUUID();
    
    // ЯВНО УКАЗЫВАЕМ is_active = 1
    await db.run(`
        INSERT INTO items (id, type, title, image_url, price_eur, sell_price_eur, rarity, stock, is_active) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) 
        ON CONFLICT(id) DO UPDATE SET type=excluded.type, title=excluded.title, image_url=excluded.image_url, price_eur=excluded.price_eur, sell_price_eur=excluded.sell_price_eur, rarity=excluded.rarity, stock=excluded.stock, is_active=1
    `, newItemId, type, title, image_url, price_eur, sell_price_eur, rarity, stock);
    
    res.json({ success: true, item_id: newItemId });
  } catch (e: any) { console.error("ADD ITEM ERROR:", e); res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.run("BEGIN TRANSACTION");
    await db.run("DELETE FROM case_items WHERE item_id = ?", id);
    await db.run("DELETE FROM items WHERE id = ?", id);
    await db.run("COMMIT");
    res.json({ success: true });
  } catch (e: any) { await db.run("ROLLBACK"); res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/items", async (req, res) => {
  try {
      // УБРАЛИ WHERE is_active = 1 на всякий случай, чтобы видеть все
      const items = await db.all("SELECT * FROM items ORDER BY title ASC");
      console.log(`📤 Sending ${items.length} items to frontend`); // <-- СМОТРИ СЮДА В ЛОГАХ
      res.json({ success: true, items });
  } catch (e: any) {
      console.error("Load Items Error:", e);
      res.status(500).json({ error: "Failed to load items" });
  }
});

app.post("/api/admin/cases", async (req, res) => {
  try {
    const { id, title, type, threshold_eur, image_url, items } = req.body;
    await db.run("BEGIN TRANSACTION");
    await db.run(`INSERT INTO cases (id, title, type, threshold_eur, image_url) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, type=excluded.type, threshold_eur=excluded.threshold_eur, image_url=excluded.image_url`, id, title, type, threshold_eur, image_url);
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
  const result = [];
  for (const c of cases) {
    const items = await db.all(`SELECT ci.item_id, ci.weight, ci.rarity, i.title, i.image_url FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ?`, c.id);
    result.push({ ...c, items });
  }
  res.json({ success: true, cases: result });
});

app.post("/api/auth/session", async (req, res) => {
  try {
    const { login, password } = req.body;
    const authData = await gqlRequest<{ clientLogin: { access_token: string } }>(`mutation CL($i: ClientLoginInput!) { clientLogin(input: $i) { access_token } }`, { i: { login, password } });
    const clientToken = authData.clientLogin.access_token;
    const meData = await gqlRequest<{ clientMe: { uuid: string, nickname: string } }>(`query { clientMe { uuid nickname } }`, {}, clientToken);
    const { uuid, nickname } = meData.clientMe;
    
    const sessionToken = crypto.randomUUID();
    const now = Date.now();
    await db.run("DELETE FROM sessions WHERE user_uuid = ?", uuid);
    await db.run(`INSERT INTO sessions (token, user_uuid, nickname, created_at, last_seen_at, expires_at, client_access_token) VALUES (?, ?, ?, ?, ?, ?, ?)`, sessionToken, uuid, nickname, now, now, now + 86400000, clientToken);
    
    const [progress, balance] = await Promise.all([calculateProgressSafe(uuid), getClientBalance(uuid)]);
    console.log(`[AUTH] Success for ${nickname}. Balance: ${balance}`);

    res.json({ success: true, session_token: sessionToken, profile: { uuid, nickname, balance: balance, dailySum: progress.daily, monthlySum: progress.monthly, cases: [] } });
  } catch (e: any) { 
    console.error("[AUTH] Failed:", e.message); 
    res.status(401).json({ success: false, error: "Invalid credentials" }); 
  }
});

app.get("/api/profile", requireSession, async (req, res) => {
  const { user_uuid, nickname } = res.locals.session;
  const [progress, balance] = await Promise.all([calculateProgressSafe(user_uuid), getClientBalance(user_uuid)]);
  const casesDB = await db.all("SELECT * FROM cases WHERE is_active = 1");
  const claims = await db.all(`SELECT case_id FROM case_claims WHERE user_uuid = ? AND (period_key = ? OR period_key = ?)`, user_uuid, getRigaDayKey(), getRigaMonthKey());
  const claimedIds = new Set(claims.map((c: any) => c.case_id));
  const openedToday = claims.filter((c: any) => c.period_key === getRigaDayKey()).length;
  const cases = casesDB.map((cfg: any) => {
    const current = cfg.type === "daily" ? progress.daily : progress.monthly;
    return { ...cfg, progress: current, available: current >= cfg.threshold_eur && !claimedIds.has(cfg.id), is_claimed: claimedIds.has(cfg.id) };
  });
  res.json({ success: true, profile: { uuid: user_uuid, nickname, balance, dailySum: progress.daily, monthlySum: progress.monthly, dailyStats: { deposited: progress.daily, opened: openedToday }, monthlyStats: { deposited: progress.monthly }, cases } });
});

app.get("/api/inventory", requireSession, async (req, res) => {
  const items = await db.all("SELECT * FROM inventory WHERE user_uuid = ? AND status = 'PENDING' ORDER BY created_at DESC", res.locals.session.user_uuid);
  res.json({ items });
});

app.post("/api/inventory/sell", requireSession, async (req, res) => {
  try {
    const item = await db.get("SELECT * FROM inventory WHERE id = ? AND user_uuid = ?", req.body.inventory_id, res.locals.session.user_uuid);
    if (!item || item.status !== "PENDING") return res.status(400).json({ error: "Item not available" });
    await db.run("UPDATE inventory SET status = 'SOLD', updated_at = ? WHERE id = ?", Date.now(), item.id);
    res.json({ success: true, sold_amount: item.sell_price_eur });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/cases/open", requireSession, async (req, res) => {
  try {
    const { user_uuid } = res.locals.session;
    const { caseId } = req.body;
    const caseMeta = await db.get("SELECT * FROM cases WHERE id = ?", caseId);
    if (!caseMeta) return res.status(404).json({ error: "Case not found" });
    const periodKey = caseMeta.type === "daily" ? getRigaDayKey() : getRigaMonthKey();
    if (await db.get("SELECT id FROM case_claims WHERE user_uuid=? AND case_id=? AND period_key=?", user_uuid, caseId, periodKey)) return res.status(400).json({ error: "Already opened" });
    const progress = await calculateProgressSafe(user_uuid);
    if ((caseMeta.type === "daily" ? progress.daily : progress.monthly) < caseMeta.threshold_eur) return res.status(403).json({ error: "Not enough deposit" });
    const caseItems = await db.all(`SELECT ci.*, i.stock FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ? AND (i.stock = -1 OR i.stock > 0)`, caseId);
    if (!caseItems.length) return res.status(500).json({ error: "Case empty" });
    let rnd = Math.random() * caseItems.reduce((acc: number, i: any) => acc + i.weight, 0);
    const selectedLink = caseItems.find((i: any) => (rnd -= i.weight) <= 0) || caseItems[0];
    const prizeItem = await db.get("SELECT * FROM items WHERE id = ?", selectedLink.item_id);
    await db.run("BEGIN TRANSACTION");
    if (prizeItem.stock > 0) await db.run("UPDATE items SET stock = stock - 1 WHERE id = ?", prizeItem.id);
    await db.run("INSERT INTO case_claims (user_uuid, case_id, period_key, claimed_at) VALUES (?, ?, ?, ?)", user_uuid, caseId, periodKey, Date.now());
    await db.run(`INSERT INTO spins (user_uuid, case_id, period_key, prize_title, prize_amount_eur, rarity, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, user_uuid, caseId, periodKey, prizeItem.title, prizeItem.price_eur, selectedLink.rarity, prizeItem.image_url, Date.now());
    await db.run(`INSERT INTO inventory (user_uuid, item_id, title, type, image_url, amount_eur, sell_price_eur, rarity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`, user_uuid, prizeItem.id, prizeItem.title, prizeItem.type, prizeItem.image_url, prizeItem.price_eur, prizeItem.sell_price_eur, selectedLink.rarity, Date.now(), Date.now());
    await db.run("COMMIT");
    res.json({ success: true, prize: { id: prizeItem.id, name: prizeItem.title, image: prizeItem.image_url, rarity: selectedLink.rarity, value: prizeItem.price_eur } });
  } catch (e: any) { await db.run("ROLLBACK"); res.status(500).json({ error: e.message }); }
});

initDB().then(async database => { db = database; app.listen(PORT, "0.0.0.0", () => console.log(`[Backend] Started on port ${PORT}`)); });