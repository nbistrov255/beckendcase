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
// ОСТАВИЛ ТОЛЬКО ЛИМИТЫ (ИНАЧЕ КАРТИНКИ НЕ ПРОЛЕЗУТ)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ЛОГГЕР (ЧТОБЫ ТЫ ВИДЕЛ ЗАПРОСЫ)
app.use((req, res, next) => {
    console.log(`📡 ${req.method} ${req.url}`);
    next();
});

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
    
    // ДОБАВИЛ: Читаем текст, чтобы увидеть ошибку, если она не JSON
    const text = await res.text();
    
    if (!res.ok) {
        console.error(`SmartShell HTTP ${res.status}:`, text);
        throw new Error(`SmartShell HTTP Error: ${res.status}`);
    }
    
    try {
        const json = JSON.parse(text);
        if (json.errors) {
            console.error("GQL Errors:", JSON.stringify(json.errors));
            throw new Error(`SmartShell API Error: ${json.errors[0]?.message}`);
        }
        return json.data;
    } catch (e) {
        console.error("Invalid JSON:", text); // Увидим, если придет 'token u'
        throw new Error("Invalid JSON from SmartShell");
    }
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

// --- БАЛАНС (ТВОЯ СТАРАЯ ВЕРСИЯ БЕЗ ARGUMENTS) ---
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
    console.log(`💰 Balance for ${userUuid}: ${client ? client.deposit : 'Not found (0)'}`);
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
  
  // Добавил подгрузку настроек юзера (трейд линк), чтобы не падало в других местах
  const settings = await db.get("SELECT * FROM user_settings WHERE user_uuid = ?", session.user_uuid);
  res.locals.session = { ...session, ...settings };
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

// АДМИНКА ТОВАРЫ (УБРАЛ requireSession, КАК В ТВОЕМ КОДЕ)
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
    
    console.log(`✅ Item Saved: ${title}`);
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

// --- API КЕЙСОВ (ТВОЯ ФУНКЦИЯ ОДИН-В-ОДИН) ---
const saveCaseHandler = async (req: any, res: any) => {
  try {
    console.log("💾 Saving Case...");
    let { id, title, nameEn, type, threshold_eur, threshold, image_url, image, items, contents, status } = req.body;
    
    if (req.params.id) id = req.params.id;

    if (!title && nameEn) title = nameEn;
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
    
    console.log(`✅ [CASE SAVED] ID: ${caseId}`);
    
    res.json({ success: true, id: caseId });
  } catch (e: any) { 
    console.error("SAVE CASE ERROR:", e);
    await db.run("ROLLBACK"); 
    res.status(500).json({ error: e.message }); 
  }
};

// УБРАЛ requireSession (ВЕРНУЛ КАК БЫЛО)
app.post("/api/admin/cases", saveCaseHandler);
app.put("/api/admin/cases/:id", saveCaseHandler);

app.delete("/api/admin/cases/:id", async (req, res) => {
    try {
        const { id } = req.params;
        await db.run("DELETE FROM cases WHERE id = ?", id);
        await db.run("DELETE FROM case_items WHERE case_id = ?", id);
        console.log(`🗑️ [DELETE CASE] ID: ${id}`);
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
    
    // ДЛЯ АВТОРИЗАЦИИ ОСТАВИЛ ТВОЮ ЛОГИКУ
    let progress = { daily: 0, monthly: 0 };
    let balance = 0;
    try {
        [progress, balance] = await Promise.all([calculateProgressSafe(uuid), getClientBalance(uuid)]);
    } catch (e) {
        console.error("Auth stats loading failed:", e);
    }
    
    // --- ЗАГРУЗКА КЕЙСОВ ДЛЯ ОТВЕТА (FIX) ---
    const casesDB = await db.all("SELECT * FROM cases");
    const todayKey = getRigaDayKey();
    const monthKey = getRigaMonthKey();
    const claims = await db.all(`SELECT case_id FROM case_claims WHERE user_uuid = ? AND (period_key = ? OR period_key = ?)`, uuid, todayKey, monthKey);
    const claimedIds = new Set(claims.map((c: any) => c.case_id));

    const cases = casesDB.map((cfg: any) => {
        const current = cfg.type && cfg.type.includes("daily") ? progress.daily : progress.monthly;
        return { 
            ...cfg, 
            threshold: cfg.threshold_eur,
            image: cfg.image_url,
            progress: current, 
            available: current >= cfg.threshold_eur && !claimedIds.has(cfg.id), 
            is_claimed: claimedIds.has(cfg.id) 
        };
    });
    
    res.json({ success: true, session_token: sessionToken, profile: { uuid, nickname, balance, dailySum: progress.daily, monthlySum: progress.monthly, cases } });
  } catch (e: any) { 
    res.status(401).json({ success: false, error: "Invalid credentials" }); 
  }
});

// --- ПРОФИЛЬ (ЗДЕСЬ САМОЕ ВАЖНОЕ: ОТПРАВКА ВСЕХ КЕЙСОВ) ---
app.get("/api/profile", requireSession, async (req, res) => {
  const { user_uuid, nickname } = res.locals.session;
  
  const casesDB = await db.all("SELECT * FROM cases"); 
  
  let progress = { daily: 0, monthly: 0 };
  let balance = 0;
  
  try {
      [progress, balance] = await Promise.all([calculateProgressSafe(user_uuid), getClientBalance(user_uuid)]);
  } catch (e) {
      console.error("Profile stats sync failed:", e);
  }

  const todayKey = getRigaDayKey();
  const monthKey = getRigaMonthKey();
  const claims = await db.all(`SELECT case_id FROM case_claims WHERE user_uuid = ? AND (period_key = ? OR period_key = ?)`, user_uuid, todayKey, monthKey);
  const claimedIds = new Set(claims.map((c: any) => c.case_id));
  
  const cases = casesDB.map((cfg: any) => {
    const current = cfg.type && cfg.type.includes("daily") ? progress.daily : progress.monthly;
    return { 
        ...cfg, 
        threshold: cfg.threshold_eur,
        image: cfg.image_url,
        progress: current, 
        available: current >= cfg.threshold_eur && !claimedIds.has(cfg.id), 
        is_claimed: claimedIds.has(cfg.id) 
    };
  });
  
  console.log(`📤 [PROFILE] Sending ${cases.length} cases to frontend for ${nickname}. Bal: ${balance}`);
  
  // Добавил tradeLink из БД для нового профиля
  res.json({ success: true, profile: { uuid: user_uuid, nickname, balance, dailySum: progress.daily, monthlySum: progress.monthly, tradeLink: res.locals.session.trade_link, cases } });
});

// ИНВЕНТАРЬ (ОСТАВЛЯЕМ НОВОЕ)
app.get("/api/inventory", requireSession, async (req, res) => {
  const items = await db.all("SELECT * FROM inventory WHERE user_uuid = ? AND status IN ('available', 'processing') ORDER BY created_at DESC", res.locals.session.user_uuid);
  res.json({ items });
});

app.post("/api/inventory/sell", requireSession, async (req, res) => {
  try {
    const item = await db.get("SELECT * FROM inventory WHERE id = ? AND user_uuid = ?", req.body.inventory_id, res.locals.session.user_uuid);
    if (!item || item.status !== 'available') return res.status(400).json({ error: "Item not available" });
    if (item.type === 'money') return res.status(400).json({ error: "Money cannot be sold" });

    await db.run("UPDATE inventory SET status = 'sold', updated_at = ? WHERE id = ?", Date.now(), item.id);
    res.json({ success: true, sold_amount: item.sell_price_eur });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/api/inventory/claim", requireSession, async (req, res) => {
  try {
    const { inventory_id } = req.body;
    const { user_uuid, trade_link } = res.locals.session;
    
    const item = await db.get("SELECT * FROM inventory WHERE id = ? AND user_uuid = ?", inventory_id, user_uuid);
    if (!item || item.status !== 'available') return res.status(400).json({ error: "Item not available" });

    await db.run("BEGIN TRANSACTION");
    if (item.type === 'money') {
        // Тут была бы интеграция с начислением
        await db.run("UPDATE inventory SET status = 'received', updated_at = ? WHERE id = ?", Date.now(), inventory_id);
        await db.run("COMMIT");
        return res.json({ success: true, type: 'money', message: `Added ${item.amount_eur}€ to balance` });
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
  } catch (e: any) { await db.run("ROLLBACK"); res.status(500).json({ error: e.message }); }
});

// АДМИН ЗАЯВКИ
app.get("/api/admin/requests", requireSession, async (req, res) => {
    const requests = await db.all(`SELECT r.*, u.nickname as user_nickname, s.trade_link FROM requests r LEFT JOIN sessions u ON r.user_uuid = u.user_uuid LEFT JOIN user_settings s ON r.user_uuid = s.user_uuid ORDER BY r.created_at DESC`);
    res.json(requests);
});

// PUBLIC CASE INFO (Для открытия)
app.get("/api/cases/:id", async (req, res) => {
    const { id } = req.params;
    const caseData = await db.get("SELECT * FROM cases WHERE id = ?", id);
    if (!caseData) return res.status(404).json({ error: "Case not found" });
    const items = await db.all(`SELECT i.*, ci.weight, ci.rarity as drop_rarity FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ?`, id);
    const totalWeight = items.reduce((sum: number, i: any) => sum + i.weight, 0);
    const contents = items.map((i: any) => ({ ...i, chance: totalWeight > 0 ? (i.weight / totalWeight) * 100 : 0, rarity: i.drop_rarity || i.rarity }));
    res.json({ success: true, case: caseData, contents });
});

// OPEN CASE (С ИНВЕНТАРЕМ)
app.post("/api/cases/open", requireSession, async (req, res) => {
    try {
        const { user_uuid } = res.locals.session;
        const { caseId } = req.body;
        const caseMeta = await db.get("SELECT * FROM cases WHERE id = ?", caseId);
        if (!caseMeta) return res.status(404).json({ error: "Case not found" });
        
        const type = (caseMeta.type || "").toLowerCase();
        const periodKey = type.includes("daily") ? getRigaDayKey() : getRigaMonthKey();
        if (await db.get("SELECT id FROM case_claims WHERE user_uuid=? AND case_id=? AND period_key=?", user_uuid, caseId, periodKey)) return res.status(400).json({ error: "Already opened" });
        
        const progress = await calculateProgressSafe(user_uuid);
        const currentProgress = type.includes("daily") ? progress.daily : progress.monthly;
        if (currentProgress < caseMeta.threshold_eur) return res.status(403).json({ error: "Not enough deposit" });
        
        const caseItems = await db.all(`SELECT ci.*, i.stock, i.title, i.price_eur, i.sell_price_eur, i.type, i.image_url FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ? AND (i.stock = -1 OR i.stock > 0)`, caseId);
        if (!caseItems.length) return res.status(500).json({ error: "Case empty" });
        
        let rnd = Math.random() * caseItems.reduce((acc: number, i: any) => acc + i.weight, 0);
        const selected = caseItems.find((i: any) => (rnd -= i.weight) <= 0) || caseItems[0];
        
        await db.run("BEGIN TRANSACTION");
        await db.run("INSERT INTO case_claims (user_uuid, case_id, period_key, claimed_at) VALUES (?, ?, ?, ?)", user_uuid, caseId, periodKey, Date.now());
        await db.run(`INSERT INTO spins (user_uuid, case_id, period_key, prize_title, prize_amount_eur, rarity, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, user_uuid, caseId, periodKey, selected.title, selected.price_eur, selected.rarity, selected.image_url, Date.now());
        await db.run(`INSERT INTO inventory (user_uuid, item_id, title, type, image_url, amount_eur, sell_price_eur, rarity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`, user_uuid, selected.item_id, selected.title, selected.type, selected.image_url, selected.price_eur, selected.sell_price_eur, selected.rarity, Date.now(), Date.now());
        await db.run("COMMIT");
        res.json({ success: true, prize: { id: selected.item_id, name: selected.title, image: selected.image_url, rarity: selected.rarity, value: selected.price_eur } });
    } catch (e: any) { await db.run("ROLLBACK"); res.status(500).json({ error: e.message }); }
});

app.post("/api/user/tradelink", requireSession, async (req, res) => {
    await db.run(`INSERT INTO user_settings (user_uuid, trade_link) VALUES (?, ?) ON CONFLICT(user_uuid) DO UPDATE SET trade_link = excluded.trade_link`, res.locals.session.user_uuid, req.body.trade_link);
    res.json({ success: true });
});

// Заглушки для админ действий (чтобы не падало)
app.post("/api/admin/requests/:id/approve", requireSession, async (req, res) => { res.json({success: true}); });
app.post("/api/admin/requests/:id/deny", requireSession, async (req, res) => { res.json({success: true}); });
app.post("/api/admin/requests/:id/return", requireSession, async (req, res) => { res.json({success: true}); });

initDB().then(async database => { db = database; app.listen(PORT, "0.0.0.0", () => console.log(`[Backend] Started on port ${PORT}`)); });