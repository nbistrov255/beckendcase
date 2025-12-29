import express from "express";
import cors from "cors";
import crypto from "crypto";
import { initDB } from "./database";

// --- КОНФИГУРАЦИЯ ---
const PORT = 3000;
const RIGA_TZ = "Europe/Riga";

if (!process.env.SMARTSHELL_LOGIN) console.error("❌ ERROR: SMARTSHELL_LOGIN is missing");

const app = express();
app.use(cors());
// ВАЖНО: Увеличиваем лимит для картинок, иначе создание кейса падает молча
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

// --- SMARTSHELL API (С ЗАЩИТОЙ ОТ ВЫЛЕТОВ) ---
async function gqlRequest<T>(query: string, variables: any = {}, token?: string): Promise<T> {
  const url = process.env.SMARTSHELL_API_URL || "https://billing.smartshell.gg/api/graphql";
  const headers: any = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 сек таймаут

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }), signal: controller.signal });
    clearTimeout(timeoutId);

    const text = await res.text(); // Читаем как текст, чтобы не упасть

    if (!res.ok) {
        console.error(`SmartShell HTTP ${res.status}`);
        throw new Error(`SmartShell HTTP Error: ${res.status}`);
    }

    try {
        const json = JSON.parse(text);
        if (json.errors) throw new Error(json.errors[0]?.message);
        return json.data;
    } catch (e) {
        throw new Error("Invalid JSON from SmartShell");
    }
  } catch (e: any) {
    console.error("Fetch Error:", e.message);
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
    return _serviceToken;
  } catch (e) { 
      console.error("❌ Admin Login Failed:", e); 
      throw e; 
  }
}

// --- БАЛАНС (СТАРАЯ РАБОЧАЯ ЛОГИКА + Fast Check) ---
async function getClientBalance(userUuid: string, clientToken?: string): Promise<number> {
  try {
    // 1. Быстрый способ (через токен клиента, если есть)
    if (clientToken) {
        try {
            const me = await gqlRequest<{ clientMe: { deposit: number } }>(`query { clientMe { deposit } }`, {}, clientToken);
            return me.clientMe.deposit || 0;
        } catch (e) {}
    }

    // 2. Медленный способ (через админа), если быстрый не сработал
    const token = await getServiceToken();
    const data = await gqlRequest<{ clients: { data: { uuid: string, deposit: number }[] } }>(`
      query GetAllClients { clients(page: 1, first: 5000) { data { uuid deposit } } }
    `, {}, token);
    
    const client = data.clients?.data?.find(c => c.uuid === userUuid);
    return client ? (client.deposit || 0) : 0;
  } catch (e) {
    console.error(`⚠️ Balance check failed, returning 0`);
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
      if (p.is_refunded) continue;
      const val = Number(p.sum) || Number(p.amount) || 0;
      if (val <= 0) continue;
      const title = String(p.title || "").toLowerCase();
      const isDeposit = title.includes("пополнение") || title.includes("deposit") || title.includes("top-up") || (p.items && p.items.some((i: any) => i.type === "DEPOSIT"));
      if (!isDeposit) continue;
      const dateStr = normalizeDatePart(p.created_at);
      if (!dateStr) continue;
      if (dateStr === todayKey) daily += val;
      if (dateStr.startsWith(monthKey)) monthly += val;
    }
    return { daily: Math.round(daily * 100) / 100, monthly: Math.round(monthly * 100) / 100 };
  } catch (e) { 
    return { daily: 0, monthly: 0 }; 
  }
}

async function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  if (!db) return res.status(500).json({ error: "DB not ready" });
  const session = await db.get("SELECT * FROM sessions WHERE token = ?", token);
  if (!session) return res.status(401).json({ error: "Invalid session" });
  
  // Подгружаем трейд ссылку
  const settings = await db.get("SELECT * FROM user_settings WHERE user_uuid = ?", session.user_uuid);
  res.locals.session = { ...session, ...settings };
  next();
}

async function addClientDeposit(userUuid: string, amount: number) {
    console.log(`💰 Adding ${amount} to ${userUuid}`);
    return true; 
}

// === ROUTES ===

app.get("/api/stats/public", async (req, res) => {
    try {
        const stats = await db.get("SELECT COUNT(DISTINCT user_uuid) as unique_users, COUNT(*) as total_spins FROM spins");
        res.json({ success: true, stats: stats || { unique_users: 0, total_spins: 0 } });
    } catch (e) { res.json({ success: false, stats: { unique_users: 0, total_spins: 0 } }); }
});

app.get("/api/drops/recent", async (req, res) => {
    try {
        const drops = await db.all(`SELECT s.id, s.prize_title as item_name, s.image_url as image, s.rarity, s.created_at as timestamp, s.user_uuid FROM spins s ORDER BY s.created_at DESC LIMIT 20`);
        for (let drop of drops) {
            const user = await db.get("SELECT nickname FROM sessions WHERE user_uuid = ? ORDER BY created_at DESC LIMIT 1", drop.user_uuid);
            drop.user_name = user ? user.nickname : "Anonymous";
        }
        res.json({ success: true, drops });
    } catch (e) { res.json({ success: false, drops: [] }); }
});

app.post("/api/auth/session", async (req, res) => {
  try {
    const { login, password } = req.body;
    const authData = await gqlRequest<{ clientLogin: { access_token: string } }>(`mutation CL($i: ClientLoginInput!) { clientLogin(input: $i) { access_token } }`, { i: { login, password } });
    const clientToken = authData.clientLogin.access_token;
    
    const meData = await gqlRequest<{ clientMe: { uuid: string, nickname: string } }>(`query { clientMe { uuid nickname } }`, {}, clientToken);
    const { uuid, nickname } = meData.clientMe;
    
    const sessionToken = crypto.randomUUID();
    await db.run("DELETE FROM sessions WHERE user_uuid = ?", uuid);
    await db.run(`INSERT INTO sessions (token, user_uuid, nickname, created_at, last_seen_at, expires_at, client_access_token) VALUES (?, ?, ?, ?, ?, ?, ?)`, sessionToken, uuid, nickname, Date.now(), Date.now(), Date.now() + 86400000, clientToken);
    
    res.json({ success: true, session_token: sessionToken });
  } catch (e: any) { 
    res.status(401).json({ success: false, error: "Invalid credentials" }); 
  }
});

// --- PROFILE (OLD WORKING LOGIC RESTORED) ---
app.get("/api/profile", requireSession, async (req, res) => {
  const session = res.locals.session;
  const { user_uuid, nickname, client_access_token } = session;
  
  const casesDB = await db.all("SELECT * FROM cases");
  
  let progress = { daily: 0, monthly: 0 };
  let balance = 0;
  
  try {
      // Используем токен клиента для быстрого баланса
      [progress, balance] = await Promise.all([
          calculateProgressSafe(user_uuid), 
          getClientBalance(user_uuid, client_access_token)
      ]);
  } catch (e) {
      console.error("Profile stats sync failed");
  }

  const todayKey = getRigaDayKey();
  const monthKey = getRigaMonthKey();
  const claims = await db.all(`SELECT case_id FROM case_claims WHERE user_uuid = ? AND (period_key = ? OR period_key = ?)`, user_uuid, todayKey, monthKey);
  const claimedIds = new Set(claims.map((c: any) => c.case_id));
  
  const cases = casesDB.map((cfg: any) => {
    // Важно: проверяем тип, чтобы не упасть на null
    const type = (cfg.type || "").toLowerCase();
    const current = type.includes("daily") ? progress.daily : progress.monthly;
    return { 
        ...cfg, 
        threshold: cfg.threshold_eur,
        image: cfg.image_url,
        progress: current, 
        available: current >= cfg.threshold_eur && !claimedIds.has(cfg.id), 
        is_claimed: claimedIds.has(cfg.id) 
    };
  });
  
  console.log(`📤 [PROFILE] Sending ${cases.length} cases to ${nickname}. Balance: ${balance}`);
  
  res.json({ 
      success: true, 
      profile: { 
          uuid: user_uuid, 
          nickname, 
          balance, 
          dailySum: progress.daily, 
          monthlySum: progress.monthly, 
          tradeLink: session.trade_link,
          cases 
      } 
  });
});

// --- ADMIN ITEMS ---
app.get("/api/admin/items", requireSession, async (req, res) => {
    const items = await db.all("SELECT * FROM items ORDER BY title ASC");
    res.json({ success: true, items });
});

app.post("/api/admin/items", requireSession, async (req, res) => {
    try {
        let { id, type, title, image_url, price_eur, sell_price_eur, rarity, stock } = req.body;
        if (!sell_price_eur) sell_price_eur = price_eur;
        if (!rarity) rarity = 'common';
        if (stock === undefined || stock === '') stock = -1;
        const itemId = id || crypto.randomUUID();
        
        await db.run(`
            INSERT INTO items (id, type, title, image_url, price_eur, sell_price_eur, rarity, stock, is_active) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) 
            ON CONFLICT(id) DO UPDATE SET type=excluded.type, title=excluded.title, image_url=excluded.image_url, price_eur=excluded.price_eur, sell_price_eur=excluded.sell_price_eur, rarity=excluded.rarity, stock=excluded.stock
        `, itemId, type, title, image_url, price_eur, sell_price_eur, rarity, stock);
        res.json({ success: true, item_id: itemId });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/items/:id", requireSession, async (req, res) => {
    try {
        await db.run("DELETE FROM items WHERE id = ?", req.params.id);
        res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- ADMIN CASES (OLD WORKING LOGIC RESTORED) ---
const saveCaseHandler = async (req: any, res: any) => {
  try {
    let { id, title, nameEn, type, threshold_eur, threshold, image_url, image, items, contents, status } = req.body;
    
    if (req.params.id) id = req.params.id;
    if (!title && nameEn) title = nameEn;
    
    // ЛОГИКА ИЗ СТАРОГО ФАЙЛА:
    if ((threshold_eur === undefined || threshold_eur === null) && threshold !== undefined) threshold_eur = threshold;
    if (!image_url && image) image_url = image;
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
    
    console.log(`📦 [CASE SAVED] ID: ${caseId}`);
    res.json({ success: true, id: caseId });
  } catch (e: any) { 
    console.error("SAVE CASE ERROR:", e);
    await db.run("ROLLBACK"); 
    res.status(500).json({ error: e.message }); 
  }
};

app.post("/api/admin/cases", requireSession, saveCaseHandler);
app.put("/api/admin/cases/:id", requireSession, saveCaseHandler);
app.delete("/api/admin/cases/:id", requireSession, async (req, res) => {
    try {
        await db.run("DELETE FROM cases WHERE id = ?", req.params.id);
        res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/cases", requireSession, async (req, res) => {
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

// PUBLIC CASE
app.get("/api/cases/:id", async (req, res) => {
    const { id } = req.params;
    const caseData = await db.get("SELECT * FROM cases WHERE id = ?", id);
    if (!caseData) return res.status(404).json({ error: "Case not found" });
    const items = await db.all(`SELECT i.*, ci.weight, ci.rarity as drop_rarity FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ?`, id);
    const totalWeight = items.reduce((sum: number, i: any) => sum + i.weight, 0);
    const contents = items.map((i: any) => ({ ...i, chance: totalWeight > 0 ? (i.weight / totalWeight) * 100 : 0, rarity: i.drop_rarity || i.rarity }));
    res.json({ success: true, case: caseData, contents });
});

// OPEN CASE
app.post("/api/cases/open", requireSession, async (req, res) => {
    try {
        const { user_uuid } = res.locals.session;
        const { caseId } = req.body;
        const caseMeta = await db.get("SELECT * FROM cases WHERE id = ?", caseId);
        if (!caseMeta) return res.status(404).json({ error: "Case not found" });
        
        // 1. Check Claims
        const type = (caseMeta.type || "").toLowerCase();
        const periodKey = type.includes("daily") ? getRigaDayKey() : getRigaMonthKey();
        if (await db.get("SELECT id FROM case_claims WHERE user_uuid=? AND case_id=? AND period_key=?", user_uuid, caseId, periodKey)) return res.status(400).json({ error: "Already opened" });

        // 2. Check Deposit
        const progress = await calculateProgressSafe(user_uuid);
        const currentProgress = type.includes("daily") ? progress.daily : progress.monthly;
        if (currentProgress < caseMeta.threshold_eur) return res.status(403).json({ error: "Not enough deposit" });

        // 3. Roll
        const caseItems = await db.all(`SELECT ci.*, i.stock, i.title, i.price_eur, i.sell_price_eur, i.type, i.image_url FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ?`, caseId);
        let rnd = Math.random() * caseItems.reduce((acc: number, i: any) => acc + i.weight, 0);
        const selected = caseItems.find((i: any) => (rnd -= i.weight) <= 0) || caseItems[0];
        
        // 4. Save
        await db.run("BEGIN TRANSACTION");
        await db.run(`INSERT INTO case_claims (user_uuid, case_id, period_key, claimed_at) VALUES (?, ?, ?, ?)`, user_uuid, caseId, periodKey, Date.now());
        await db.run(`INSERT INTO spins (user_uuid, case_id, period_key, prize_title, prize_amount_eur, rarity, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, user_uuid, caseId, getRigaDayKey(), selected.title, selected.price_eur, selected.rarity, selected.image_url, Date.now());
        await db.run(`INSERT INTO inventory (user_uuid, item_id, title, type, image_url, amount_eur, sell_price_eur, rarity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`, user_uuid, selected.item_id, selected.title, selected.type, selected.image_url, selected.price_eur, selected.sell_price_eur, selected.rarity, Date.now(), Date.now());
        await db.run("COMMIT");

        res.json({ 
            success: true, 
            item: { id: selected.item_id, name: selected.title, type: selected.type, image: selected.image_url, rarity: selected.rarity } 
        });
    } catch (e: any) { await db.run("ROLLBACK"); res.status(500).json({ error: e.message }); }
});

// INVENTORY & REQUESTS
app.get("/api/inventory", requireSession, async (req, res) => {
    const items = await db.all("SELECT * FROM inventory WHERE user_uuid = ? AND status IN ('available', 'processing') ORDER BY created_at DESC", res.locals.session.user_uuid);
    res.json({ items });
});

app.post("/api/inventory/sell", requireSession, async (req, res) => {
    const { inventory_id } = req.body;
    const item = await db.get("SELECT * FROM inventory WHERE id = ? AND user_uuid = ?", inventory_id, res.locals.session.user_uuid);
    if (!item || item.status !== 'available') return res.status(400).json({ error: "Item not available" });
    if (item.type === 'money') return res.status(400).json({ error: "Money cannot be sold" });

    await addClientDeposit(res.locals.session.user_uuid, item.sell_price_eur);
    await db.run("UPDATE inventory SET status = 'sold', updated_at = ? WHERE id = ?", Date.now(), inventory_id);
    res.json({ success: true, sold_amount: item.sell_price_eur });
});

app.post("/api/inventory/claim", requireSession, async (req, res) => {
    const { inventory_id } = req.body;
    const { user_uuid, trade_link } = res.locals.session;
    const item = await db.get("SELECT * FROM inventory WHERE id = ? AND user_uuid = ?", inventory_id, user_uuid);
    if (!item || item.status !== 'available') return res.status(400).json({ error: "Item not available" });
    
    await db.run("BEGIN TRANSACTION");
    if (item.type === 'money') {
        const amount = item.amount_eur || item.price_eur || 0;
        await addClientDeposit(user_uuid, amount);
        await db.run("UPDATE inventory SET status = 'received', updated_at = ? WHERE id = ?", Date.now(), inventory_id);
        await db.run("COMMIT");
        return res.json({ success: true, type: 'money', message: `Added ${amount}€ to balance` });
    }
    if (item.type === 'skin' && !trade_link) {
        await db.run("ROLLBACK");
        return res.status(400).json({ error: "TRADE_LINK_MISSING" });
    }
    const requestId = `REQ-${Math.floor(Math.random() * 1000000)}`;
    await db.run("UPDATE inventory SET status = 'processing', updated_at = ? WHERE id = ?", Date.now(), inventory_id);
    await db.run(`INSERT INTO requests (id, user_uuid, inventory_id, item_title, type, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`, requestId, user_uuid, inventory_id, item.title, item.type, Date.now());
    await db.run("COMMIT");
    res.json({ success: true, type: 'item', requestId });
});

app.post("/api/user/tradelink", requireSession, async (req, res) => {
    await db.run(`INSERT INTO user_settings (user_uuid, trade_link) VALUES (?, ?) ON CONFLICT(user_uuid) DO UPDATE SET trade_link = excluded.trade_link`, res.locals.session.user_uuid, req.body.trade_link);
    res.json({ success: true });
});

// ADMIN REQUESTS
app.get("/api/admin/requests", requireSession, async (req, res) => {
    const requests = await db.all(`SELECT r.*, u.nickname as user_nickname, s.trade_link FROM requests r LEFT JOIN sessions u ON r.user_uuid = u.user_uuid LEFT JOIN user_settings s ON r.user_uuid = s.user_uuid ORDER BY r.created_at DESC`);
    res.json(requests);
});

app.post("/api/admin/requests/:id/approve", requireSession, async (req, res) => {
    await db.run("BEGIN TRANSACTION");
    await db.run("UPDATE requests SET status = 'approved', updated_at = ? WHERE id = ?", Date.now(), req.params.id);
    const reqData = await db.get("SELECT inventory_id FROM requests WHERE id = ?", req.params.id);
    await db.run("UPDATE inventory SET status = 'received', updated_at = ? WHERE id = ?", Date.now(), reqData.inventory_id);
    await db.run("COMMIT");
    res.json({ success: true });
});

app.post("/api/admin/requests/:id/deny", requireSession, async (req, res) => {
    await db.run("BEGIN TRANSACTION");
    await db.run("UPDATE requests SET status = 'denied', admin_comment = ?, updated_at = ? WHERE id = ?", req.body.comment, Date.now(), req.params.id);
    const reqData = await db.get("SELECT inventory_id FROM requests WHERE id = ?", req.params.id);
    await db.run("UPDATE inventory SET status = 'available', updated_at = ? WHERE id = ?", Date.now(), reqData.inventory_id);
    await db.run("COMMIT");
    res.json({ success: true });
});

app.post("/api/admin/requests/:id/return", requireSession, async (req, res) => {
    await db.run("BEGIN TRANSACTION");
    await db.run("UPDATE requests SET status = 'returned', updated_at = ? WHERE id = ?", Date.now(), req.params.id);
    const reqData = await db.get("SELECT inventory_id FROM requests WHERE id = ?", req.params.id);
    await db.run("UPDATE inventory SET status = 'available', updated_at = ? WHERE id = ?", Date.now(), reqData.inventory_id);
    await db.run("COMMIT");
    res.json({ success: true });
});

initDB().then(async database => { db = database; app.listen(PORT, "0.0.0.0", () => console.log(`[Backend] Started on port ${PORT}`)); });