import express from "express";
import cors from "cors";
import crypto from "crypto";
import { initDB } from "./database";

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
  
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    if (!res.ok) throw new Error(`SmartShell HTTP Error: ${res.status}`);
    const json = await res.json() as any;
    if (json.errors) {
      console.error("GQL Errors:", JSON.stringify(json.errors));
      throw new Error("SmartShell API Error");
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
  console.log("Refreshing Service Token...");
  const data = await gqlRequest<{ login: { access_token: string, expires_in: number } }>(`
    mutation Login($input: LoginInput!) { login(input: $input) { access_token expires_in } }
  `, { input: { login: process.env.SMARTSHELL_LOGIN, password: process.env.SMARTSHELL_PASSWORD, company_id: Number(process.env.SMARTSHELL_CLUB_ID) } });
  
  if (!data?.login?.access_token) throw new Error("Failed to get service token");
  
  _serviceToken = data.login.access_token;
  _serviceTokenExp = Date.now() + (data.login.expires_in - 60) * 1000;
  return _serviceToken;
}

async function calculateProgress(userUuid: string) {
  const token = await getServiceToken();
  // Запрашиваем историю платежей для статистики
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

// Новый helper для получения текущего баланса кошелька
async function getClientBalance(userUuid: string) {
  const token = await getServiceToken();
  const data = await gqlRequest<{ client: { balance: number } }>(`
    query GetClient($uuid: String!) { client(uuid: $uuid) { balance } }
  `, { uuid: userUuid }, token);
  return data.client?.balance || 0;
}

async function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  
  const session = await db.get("SELECT * FROM sessions WHERE token = ?", token);
  if (!session) return res.status(401).json({ error: "Invalid session" });
  
  await db.run("UPDATE sessions SET last_seen_at = ? WHERE token = ?", Date.now(), token);
  res.locals.session = session;
  next();
}

// === PUBLIC ROUTES ===
app.get("/api/stats/public", async (req, res) => {
    try {
        const playersResult = await db.get("SELECT COUNT(DISTINCT user_uuid) as count FROM sessions");
        const casesResult = await db.get("SELECT COUNT(*) as count FROM spins");
        res.json({ uniquePlayers: playersResult?.count || 0, casesOpened: casesResult?.count || 0 });
    } catch (e: any) { res.json({ uniquePlayers: 0, casesOpened: 0 }); }
});

app.get("/api/drops/recent", async (req, res) => {
  try {
    const spins = await db.all(`
      SELECT s.id, s.prize_title as item_name, s.image_url as image, s.rarity, s.created_at as timestamp, u.nickname as user_name 
      FROM spins s LEFT JOIN sessions u ON s.user_uuid = u.user_uuid
      ORDER BY s.created_at DESC LIMIT 20
    `);
    const drops = spins.map((s: any) => ({ ...s, rarity: s.rarity || 'common', image: s.image || 'https://via.placeholder.com/150' }));
    res.json({ success: true, drops });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// === ADMIN ROUTES ===
app.post("/api/admin/items", async (req, res) => {
  try {
    let { id, type, title, image_url, price_eur, sell_price_eur, rarity, stock } = req.body;
    
    if (!sell_price_eur) sell_price_eur = price_eur;
    if (!rarity) rarity = 'common';
    if (stock === undefined || stock === '') stock = -1;

    const newItemId = id || crypto.randomUUID();
    
    await db.run(`
      INSERT INTO items (id, type, title, image_url, price_eur, sell_price_eur, rarity, stock) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET 
        type=excluded.type, 
        title=excluded.title, 
        image_url=excluded.image_url, 
        price_eur=excluded.price_eur, 
        sell_price_eur=excluded.sell_price_eur,
        rarity=excluded.rarity,
        stock=excluded.stock
    `, newItemId, type, title, image_url, price_eur, sell_price_eur, rarity, stock);
    
    res.json({ success: true, item_id: newItemId });
  } catch (e: any) { 
    console.error("Save Item Error:", e);
    res.status(500).json({ error: e.message }); 
  }
});

app.delete("/api/admin/items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.run("BEGIN TRANSACTION");
    await db.run("DELETE FROM case_items WHERE item_id = ?", id);
    await db.run("DELETE FROM items WHERE id = ?", id);
    await db.run("COMMIT");
    res.json({ success: true });
  } catch (e: any) {
    await db.run("ROLLBACK");
    res.status(500).json({ error: e.message });
  }
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
  const result = [];
  for (const c of cases) {
    const items = await db.all(`SELECT ci.item_id, ci.weight, ci.rarity, i.title, i.image_url FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ?`, c.id);
    result.push({ ...c, items });
  }
  res.json({ success: true, cases: result });
});

// === CLIENT ROUTES ===
app.post("/api/auth/session", async (req, res) => {
  try {
    const { login, password } = req.body;
    const authData = await gqlRequest<{ clientLogin: { access_token: string } }>(`mutation CL($i: ClientLoginInput!) { clientLogin(input: $i) { access_token } }`, { i: { login, password } });
    const clientToken = authData.clientLogin.access_token;
    
    // Получаем профиль и БАЛАНС
    const meData = await gqlRequest<{ clientMe: { uuid: string, nickname: string, balance: number } }>(`
      query { clientMe { uuid nickname balance } }
    `, {}, clientToken);
    
    const { uuid, nickname, balance } = meData.clientMe;
    
    const sessionToken = crypto.randomUUID();
    const now = Date.now();
    await db.run("DELETE FROM sessions WHERE user_uuid = ?", uuid);
    await db.run(`INSERT INTO sessions (token, user_uuid, nickname, created_at, last_seen_at, expires_at, client_access_token) VALUES (?, ?, ?, ?, ?, ?, ?)`, sessionToken, uuid, nickname, now, now, now + 86400000, clientToken);
    
    // Считаем депозиты
    const { daily, monthly } = await calculateProgress(uuid);
    
    res.json({ 
      success: true, 
      session_token: sessionToken, 
      profile: { 
        uuid, 
        nickname,
        balance: balance, // <-- РЕАЛЬНЫЙ БАЛАНС КОШЕЛЬКА
        dailySum: daily, // Это сумма пополнений за день (для кейсов)
        monthlySum: monthly, 
        cases: [] 
      } 
    });
  } catch (e: any) { console.error("Auth Error:", e); res.status(401).json({ success: false, error: "Invalid credentials" }); }
});

app.get("/api/profile", requireSession, async (req, res) => {
  const { user_uuid, nickname } = res.locals.session;
  
  // Параллельно получаем баланс и депозиты
  const [progress, balance] = await Promise.all([
    calculateProgress(user_uuid),
    getClientBalance(user_uuid)
  ]);
  
  const { daily, monthly } = progress;
  const todayKey = getRigaDayKey();
  const monthKey = getRigaMonthKey();
  
  const casesDB = await db.all("SELECT * FROM cases WHERE is_active = 1");
  const claims = await db.all(`SELECT case_id FROM case_claims WHERE user_uuid = ? AND (period_key = ? OR period_key = ?)`, user_uuid, todayKey, monthKey);
  const claimedIds = new Set(claims.map((c: any) => c.case_id));
  const openedToday = claims.filter((c: any) => c.period_key === todayKey).length;

  const cases = casesDB.map((cfg: any) => {
    const current = cfg.type === "daily" ? daily : monthly;
    const isClaimed = claimedIds.has(cfg.id);
    return { ...cfg, progress: current, available: current >= cfg.threshold_eur && !isClaimed, is_claimed: isClaimed };
  });

  res.json({
    success: true,
    profile: {
      uuid: user_uuid, nickname,
      balance: balance, // <-- ОТДАЕМ ФРОНТУ РЕАЛЬНЫЙ БАЛАНС
      dailySum: daily, 
      monthlySum: monthly,
      dailyStats: { deposited: daily, opened: openedToday },
      monthlyStats: { deposited: monthly },
      cases
    }
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
    if (item.status !== "PENDING") return res.status(400).json({ error: "Already sold or used" });
    
    await db.run("UPDATE inventory SET status = 'SOLD', updated_at = ? WHERE id = ?", Date.now(), inventory_id);
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
    const existing = await db.get("SELECT id FROM case_claims WHERE user_uuid=? AND case_id=? AND period_key=?", user_uuid, caseId, periodKey);
    if (existing) return res.status(400).json({ error: "Already opened" });
    
    const { daily, monthly } = await calculateProgress(user_uuid);
    const balance = caseMeta.type === "daily" ? daily : monthly;
    if (balance < caseMeta.threshold_eur) return res.status(403).json({ error: "Not enough deposit" });
    
    const caseItems = await db.all(`SELECT ci.*, i.stock FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ? AND (i.stock = -1 OR i.stock > 0)`, caseId);
    if (caseItems.length === 0) return res.status(500).json({ error: "Case is empty or out of stock!" });
    
    const totalWeight = caseItems.reduce((acc: number, item: any) => acc + item.weight, 0);
    let rnd = Math.random() * totalWeight;
    let selectedLink = caseItems[0];
    for (const link of caseItems) { rnd -= link.weight; if (rnd <= 0) { selectedLink = link; break; } }
    
    const prizeItem = await db.get("SELECT * FROM items WHERE id = ?", selectedLink.item_id);
    await db.run("BEGIN TRANSACTION");
    if (prizeItem.stock > 0) { await db.run("UPDATE items SET stock = stock - 1 WHERE id = ?", prizeItem.id); }
    await db.run("INSERT INTO case_claims (user_uuid, case_id, period_key, claimed_at) VALUES (?, ?, ?, ?)", user_uuid, caseId, periodKey, Date.now());
    await db.run(`INSERT INTO spins (user_uuid, case_id, period_key, prize_title, prize_amount_eur, rarity, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, user_uuid, caseId, periodKey, prizeItem.title, prizeItem.price_eur, selectedLink.rarity, prizeItem.image_url, Date.now());
    await db.run(`INSERT INTO inventory (user_uuid, item_id, title, type, image_url, amount_eur, sell_price_eur, rarity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`, user_uuid, prizeItem.id, prizeItem.title, prizeItem.type, prizeItem.image_url, prizeItem.price_eur, prizeItem.sell_price_eur, selectedLink.rarity, Date.now(), Date.now());
    await db.run("COMMIT");

    res.json({ success: true, prize: { id: prizeItem.id, name: prizeItem.title, image: prizeItem.image_url, rarity: selectedLink.rarity, value: prizeItem.price_eur } });
  } catch (e: any) { await db.run("ROLLBACK"); res.status(500).json({ error: e.message }); }
});

initDB().then(database => { db = database; app.listen(PORT, "0.0.0.0", () => console.log(`[Backend] Started on port ${PORT}`)); });