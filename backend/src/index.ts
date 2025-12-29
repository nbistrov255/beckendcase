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
    console.log("🔄 Refreshing Service Token...");
    const data = await gqlRequest<{ login: { access_token: string, expires_in: number } }>(`
      mutation Login($input: LoginInput!) { login(input: $input) { access_token expires_in } }
    `, { input: { login: process.env.SMARTSHELL_LOGIN, password: process.env.SMARTSHELL_PASSWORD, company_id: Number(process.env.SMARTSHELL_CLUB_ID) } });
    _serviceToken = data.login.access_token;
    _serviceTokenExp = Date.now() + (data.login.expires_in - 60) * 1000;
    console.log("✅ Service Token Refreshed");
    return _serviceToken;
  } catch (e) { 
      console.error("❌ Admin Login Failed (Check .env credentials):", e); 
      throw e; 
  }
}

// --- БАЛАНС ---
async function getClientBalance(userUuid: string): Promise<number> {
  try {
    const token = await getServiceToken();
    const data = await gqlRequest<{ clients: { data: { uuid: string, deposit: number }[] } }>(`
      query GetAllClients {
        clients {
          data { uuid deposit }
        }
      }
    `, {}, token);
    
    const client = data.clients?.data?.find(c => c.uuid === userUuid);
    return client ? (client.deposit || 0) : 0;
  } catch (e) {
    console.error(`⚠️ Failed to fetch balance:`, e);
    return 0;
  }
}

// --- СТАТИСТИКА ---
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
      if (p.is_refunded) continue;
      const val = Number(p.sum) || Number(p.amount) || 0;
      if (val <= 0) continue;

      const title = String(p.title || "").toLowerCase();
      const isDeposit = 
        title.includes("пополнение") || 
        title.includes("deposit") || 
        title.includes("top-up") || 
        (p.items && Array.isArray(p.items) && p.items.some((i: any) => i.type === "DEPOSIT"));

      if (!isDeposit) continue;

      const dateStr = normalizeDatePart(p.created_at);
      if (!dateStr) continue;

      if (dateStr === todayKey) daily += val;
      if (dateStr.startsWith(monthKey)) monthly += val;
    }
    
    console.log(`[STATS] Calculated for ${userUuid}: Daily=${daily}, Monthly=${monthly}`);
    return { daily: Math.round(daily * 100) / 100, monthly: Math.round(monthly * 100) / 100 };
  } catch (e) { 
    console.error("[STATS] Error calculating (returning 0):", e);
    return { daily: 0, monthly: 0 }; 
  }
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

app.post("/api/admin/items", async (req, res) => {
  try {
    let { id, type, title, image_url, price_eur, sell_price_eur, rarity, stock } = req.body;
    if (!sell_price_eur) sell_price_eur = price_eur;
    if (!rarity) rarity = 'common';
    if (stock === undefined || stock === '') stock = -1;
    const newItemId = id || crypto.randomUUID();
    
    await db.run(`
        INSERT INTO items (id, type, title, image_url, price_eur, sell_price_eur, rarity, stock, is_active) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) 
        ON CONFLICT(id) DO UPDATE SET type=excluded.type, title=excluded.title, image_url=excluded.image_url, price_eur=excluded.price_eur, sell_price_eur=excluded.sell_price_eur, rarity=excluded.rarity, stock=excluded.stock, is_active=1
    `, newItemId, type, title, image_url, price_eur, sell_price_eur, rarity, stock);
    
    res.json({ success: true, item_id: newItemId });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
      const items = await db.all("SELECT * FROM items ORDER BY title ASC");
      res.json({ success: true, items });
  } catch (e: any) {
      res.status(500).json({ error: "Failed to load items" });
  }
});

// --- API КЕЙСОВ ---
app.post("/api/admin/cases", async (req, res) => {
  try {
    let { id, title, nameEn, type, threshold_eur, threshold, image_url, image, items, contents, status } = req.body;
    
    // Адаптация данных
    if (!title && nameEn) title = nameEn;
    if ((threshold_eur === undefined || threshold_eur === null) && threshold !== undefined) threshold_eur = threshold;
    if (!image_url && image) image_url = image;
    
    // Статус в is_active
    const is_active = (status === 'published') ? 1 : 0;

    if ((!items || items.length === 0) && contents && Array.isArray(contents)) {
      items = contents.map((c: any) => ({
        item_id: c.itemId,
        weight: c.dropChance,
        rarity: c.item?.rarity || 'common'
      }));
    }

    const caseId = id || crypto.randomUUID();

    await db.run("BEGIN TRANSACTION");
    
    // ВАЖНО: Используем ON CONFLICT для обновления существующего кейса по ID
    await db.run(`
      INSERT INTO cases (id, title, type, threshold_eur, image_url, is_active) 
      VALUES (?, ?, ?, ?, ?, ?) 
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, type=excluded.type, threshold_eur=excluded.threshold_eur, image_url=excluded.image_url, is_active=excluded.is_active
    `, caseId, title, type, threshold_eur, image_url, is_active);
    
    await db.run("DELETE FROM case_items WHERE case_id = ?", caseId);
    
    if (items && Array.isArray(items)) {
      for (const item of items) {
        await db.run(`INSERT INTO case_items (case_id, item_id, weight, rarity) VALUES (?, ?, ?, ?)`, caseId, item.item_id, item.weight, item.rarity);
      }
    }
    
    await db.run("COMMIT");
    
    res.json({ 
        success: true, 
        id: caseId, 
        title, 
        type, 
        threshold: threshold_eur, 
        image: image_url,         
        status: is_active ? 'published' : 'draft' 
    });
  } catch (e: any) { 
    console.error("CREATE CASE ERROR:", e);
    await db.run("ROLLBACK"); 
    res.status(500).json({ error: e.message }); 
  }
});

// Удаление кейса
app.delete("/api/admin/cases/:id", async (req, res) => {
    try {
        const { id } = req.params;
        await db.run("DELETE FROM cases WHERE id = ?", id);
        await db.run("DELETE FROM case_items WHERE case_id = ?", id);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/admin/cases", async (req, res) => {
  const cases = await db.all("SELECT * FROM cases");
  const result = [];
  for (const c of cases) {
    const items = await db.all(`SELECT ci.item_id, ci.weight, ci.rarity, i.title, i.image_url FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ?`, c.id);
    result.push({ 
        ...c, 
        items,
        threshold: c.threshold_eur, 
        image: c.image_url,
        status: c.is_active ? 'published' : 'draft',
        contents: items.map((i: any) => ({
            itemId: i.item_id,
            dropChance: i.weight,
            item: { ...i, id: i.item_id, image: i.image_url, nameEn: i.title }
        }))
    });
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
    
    let progress = { daily: 0, monthly: 0 };
    let balance = 0;
    try {
        [progress, balance] = await Promise.all([calculateProgressSafe(uuid), getClientBalance(uuid)]);
    } catch (e) {
        console.error("Auth stats loading failed:", e);
    }
    
    res.json({ success: true, session_token: sessionToken, profile: { uuid, nickname, balance, dailySum: progress.daily, monthlySum: progress.monthly, cases: [] } });
  } catch (e: any) { 
    res.status(401).json({ success: false, error: "Invalid credentials" }); 
  }
});

// --- ПРОФИЛЬ (ЗДЕСЬ МЫ ВКЛЮЧИЛИ ВСЕ КЕЙСЫ) ---
app.get("/api/profile", requireSession, async (req, res) => {
  const { user_uuid, nickname } = res.locals.session;
  
  // ЗАГРУЖАЕМ ВСЕ КЕЙСЫ (даже если is_active=0, чтобы ты их увидел)
  const casesDB = await db.all("SELECT * FROM cases"); 
  
  let progress = { daily: 0, monthly: 0 };
  let balance = 0;
  
  try {
      [progress, balance] = await Promise.all([calculateProgressSafe(user_uuid), getClientBalance(user_uuid)]);
  } catch (e) {
      console.error("Profile stats sync failed (ignoring):", e);
  }

  const todayKey = getRigaDayKey();
  const monthKey = getRigaMonthKey();
  const claims = await db.all(`SELECT case_id FROM case_claims WHERE user_uuid = ? AND (period_key = ? OR period_key = ?)`, user_uuid, todayKey, monthKey);
  const claimedIds = new Set(claims.map((c: any) => c.case_id));
  const openedToday = claims.filter((c: any) => c.period_key === todayKey).length;
  
  const cases = casesDB.map((cfg: any) => {
    const current = cfg.type === "daily" ? progress.daily : progress.monthly;
    return { 
        ...cfg, 
        threshold: cfg.threshold_eur,
        image: cfg.image_url,
        progress: current, 
        available: current >= cfg.threshold_eur && !claimedIds.has(cfg.id), 
        is_claimed: claimedIds.has(cfg.id) 
    };
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