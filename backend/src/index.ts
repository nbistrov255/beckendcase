import express from "express";
import cors from "cors";
import crypto from "crypto";
import { initDB } from "./database";

// --- КОНФИГУРАЦИЯ ---
const PORT = 3000;
const RIGA_TZ = "Europe/Riga";

// Проверка переменных окружения
if (!process.env.SMARTSHELL_LOGIN) console.error("❌ ERROR: SMARTSHELL_LOGIN is missing in .env");

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

// --- SMARTSHELL API (ROBUST) ---
async function gqlRequest<T>(query: string, variables: any = {}, token?: string): Promise<T> {
  const url = process.env.SMARTSHELL_API_URL || "https://billing.smartshell.gg/api/graphql";
  const headers: any = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  
  try {
    // Таймаут 6 секунд
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(url, { 
        method: "POST", 
        headers, 
        body: JSON.stringify({ query, variables }),
        signal: controller.signal 
    });
    
    clearTimeout(timeoutId);
    
    // Читаем текст, чтобы избежать падения JSON.parse
    const text = await res.text();

    if (!res.ok) {
        console.error(`🔴 SmartShell HTTP ${res.status}:`, text.slice(0, 100));
        throw new Error(`SmartShell HTTP ${res.status}`);
    }

    try {
        const json = JSON.parse(text);
        if (json.errors) {
            console.error("🔴 SmartShell GQL Error:", json.errors[0]?.message);
            throw new Error(json.errors[0]?.message || "GraphQL Error");
        }
        return json.data;
    } catch (e) {
        console.error("🔴 SmartShell Invalid JSON:", text.slice(0, 100));
        throw new Error("Invalid response from SmartShell");
    }
  } catch (e: any) {
    console.error("⚠️ GQL Request Failed:", e.message);
    throw e;
  }
}

let _serviceToken: string | null = null;
let _serviceTokenExp = 0;
async function getServiceToken(): Promise<string> {
  if (_serviceToken && Date.now() < _serviceTokenExp) return _serviceToken;
  try {
    console.log("🔄 Refreshing SmartShell Token...");
    const data = await gqlRequest<{ login: { access_token: string, expires_in: number } }>(`
        mutation Login($input: LoginInput!) { login(input: $input) { access_token expires_in } }
    `, { input: { login: process.env.SMARTSHELL_LOGIN, password: process.env.SMARTSHELL_PASSWORD, company_id: Number(process.env.SMARTSHELL_CLUB_ID) } });
    
    if (!data?.login) throw new Error("No login data");
    _serviceToken = data.login.access_token;
    _serviceTokenExp = Date.now() + (data.login.expires_in - 60) * 1000;
    console.log("✅ SmartShell Token Refreshed");
    return _serviceToken;
  } catch (e) {
    console.error("❌ CRITICAL: Failed to get Service Token. Check .env!");
    throw e;
  }
}

// --- BALANCE & STATS ---
async function getClientBalance(userUuid: string): Promise<number> {
  try {
    const token = await getServiceToken();
    // Запрашиваем список клиентов. Это не оптимально, но в API SmartShell часто нет метода getOneClient
    const data = await gqlRequest<{ clients: { data: { uuid: string, deposit: number }[] } }>(`
      query GetAllClients { clients(page: 1, first: 5000) { data { uuid deposit } } }
    `, {}, token);
    
    const client = data.clients?.data?.find(c => c.uuid === userUuid);
    const balance = client ? (client.deposit || 0) : 0;
    console.log(`💰 Balance for ${userUuid}: ${balance} EUR`);
    return balance;
  } catch (e) {
    console.error(`⚠️ Could not fetch balance for ${userUuid}, returning 0.`);
    return 0; // Возвращаем 0, чтобы не блокировать вход
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
      const isDeposit = title.includes("пополнение") || title.includes("deposit") || title.includes("top-up") || (p.items && Array.isArray(p.items) && p.items.some((i: any) => i.type === "DEPOSIT"));
      if (!isDeposit) continue;
      
      const dateStr = normalizeDatePart(p.created_at);
      if (!dateStr) continue;
      
      if (dateStr === todayKey) daily += val;
      if (dateStr.startsWith(monthKey)) monthly += val;
    }
    return { daily: Math.round(daily * 100) / 100, monthly: Math.round(monthly * 100) / 100 };
  } catch (e) { 
    console.error("⚠️ Stats calculation failed, returning 0s");
    return { daily: 0, monthly: 0 }; 
  }
}

async function addClientDeposit(userUuid: string, amount: number) {
    console.log(`🏦 [SMARTSHELL] Request to add ${amount} EUR to ${userUuid}`);
    // Внимание: Для реального зачисления нужен метод createPayment или setDeposit
    return true; 
}

function calculateLevel(xp: number) {
    const baseXP = 100;
    let level = 1;
    let required = baseXP;
    while (xp >= required && level < 50) {
        xp -= required;
        level++;
        required = Math.floor(required * 1.2);
    }
    return { level, currentXP: Math.floor(xp), requiredXP: required };
}

// Middleware
async function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  if (!db) return res.status(500).json({ error: "DB not ready" });
  
  const session = await db.get("SELECT * FROM sessions WHERE token = ?", token);
  if (!session) return res.status(401).json({ error: "Invalid session" });
  
  const settings = await db.get("SELECT * FROM user_settings WHERE user_uuid = ?", session.user_uuid);
  res.locals.session = { ...session, ...settings };
  next();
}

// === ROUTES ===

// AUTH
app.post("/api/auth/session", async (req, res) => {
  try {
    const { login, password } = req.body;
    console.log(`🔑 Login attempt for: ${login}`);
    
    const authData = await gqlRequest<{ clientLogin: { access_token: string } }>(`mutation CL($i: ClientLoginInput!) { clientLogin(input: $i) { access_token } }`, { i: { login, password } });
    if (!authData?.clientLogin?.access_token) throw new Error("Invalid credentials");
    const clientToken = authData.clientLogin.access_token;
    
    const meData = await gqlRequest<{ clientMe: { uuid: string, nickname: string } }>(`query { clientMe { uuid nickname } }`, {}, clientToken);
    const { uuid, nickname } = meData.clientMe;
    
    const sessionToken = crypto.randomUUID();
    await db.run("DELETE FROM sessions WHERE user_uuid = ?", uuid);
    await db.run(`INSERT INTO sessions (token, user_uuid, nickname, created_at, last_seen_at, expires_at, client_access_token) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
        sessionToken, uuid, nickname, Date.now(), Date.now(), Date.now() + 86400000, clientToken);
    
    console.log(`✅ User ${nickname} logged in.`);
    res.json({ success: true, session_token: sessionToken });
  } catch (e: any) { 
    console.error("Login failed:", e.message);
    res.status(401).json({ success: false, error: "Invalid credentials" }); 
  }
});

// PROFILE (Баланс + Кейсы)
app.get("/api/profile", requireSession, async (req, res) => {
    const session = res.locals.session;
    const { user_uuid, nickname } = session;

    // Параллельная загрузка данных
    let progress = { daily: 0, monthly: 0 };
    let balance = 0;
    try {
        [progress, balance] = await Promise.all([calculateProgressSafe(user_uuid), getClientBalance(user_uuid)]);
    } catch (e) {
        console.error("Profile partial load error");
    }

    const casesDB = await db.all("SELECT * FROM cases");
    const todayKey = getRigaDayKey();
    const monthKey = getRigaMonthKey();
    const claims = await db.all(`SELECT case_id FROM case_claims WHERE user_uuid = ? AND (period_key = ? OR period_key = ?)`, user_uuid, todayKey, monthKey);
    const claimedIds = new Set(claims.map((c: any) => c.case_id));
    
    const cases = casesDB.map((cfg: any) => {
        const current = cfg.type && cfg.type.includes("daily") ? progress.daily : progress.monthly;
        return { 
            ...cfg, 
            // Дублируем поля, чтобы фронтенд точно их нашел
            threshold: cfg.threshold_eur,
            image: cfg.image_url,
            // Логика доступности
            progress: current, 
            available: current >= cfg.threshold_eur && !claimedIds.has(cfg.id), 
            is_claimed: claimedIds.has(cfg.id) 
        };
    });

    const xpData = calculateLevel(session.xp || 0);

    res.json({ 
        success: true, 
        profile: { 
            uuid: user_uuid,
            nickname: nickname,
            balance: balance, // <-- Общий баланс
            dailySum: progress.daily,
            monthlySum: progress.monthly,
            level: xpData.level,
            currentXP: xpData.currentXP,
            requiredXP: xpData.requiredXP,
            tradeLink: session.trade_link,
            cases: cases // <-- Список кейсов с правильными типами
        } 
    });
});

// STATS
app.get("/api/stats/public", async (req, res) => {
    try {
        const stats = await db.get("SELECT COUNT(DISTINCT user_uuid) as unique_users, COUNT(*) as total_spins FROM spins");
        res.json({ success: true, stats: stats || { unique_users: 0, total_spins: 0 } });
    } catch (e) { res.json({ success: false, stats: { unique_users: 0, total_spins: 0 } }); }
});

app.get("/api/drops/recent", async (req, res) => {
    try {
        const drops = await db.all(`
            SELECT s.id, s.prize_title as item_name, s.image_url as image, s.rarity, s.created_at as timestamp, s.user_uuid 
            FROM spins s ORDER BY s.created_at DESC LIMIT 20
        `);
        // Обогащаем никами
        for (let drop of drops) {
            const user = await db.get("SELECT nickname FROM sessions WHERE user_uuid = ? ORDER BY created_at DESC LIMIT 1", drop.user_uuid);
            drop.user_name = user ? user.nickname : "Anonymous";
        }
        res.json({ success: true, drops });
    } catch (e) { res.json({ success: false, drops: [] }); }
});

// ADMIN: ITEMS
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
        
        console.log(`📦 Item saved: ${title}`);
        res.json({ success: true, item_id: itemId });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/items/:id", requireSession, async (req, res) => {
    try {
        const { id } = req.params;
        await db.run("BEGIN TRANSACTION");
        await db.run("DELETE FROM case_items WHERE item_id = ?", id);
        await db.run("DELETE FROM items WHERE id = ?", id);
        await db.run("COMMIT");
        res.json({ success: true });
    } catch (e: any) { await db.run("ROLLBACK"); res.status(500).json({ error: e.message }); }
});

// ADMIN: CASES (FIXED!)
const saveCaseHandler = async (req: any, res: any) => {
  try {
    // Логика создания кейса: принимаем разные варианты параметров (threshold vs threshold_eur)
    let { id, title, nameEn, type, threshold_eur, threshold, image_url, image, items, contents, status } = req.body;
    
    if (req.params.id) id = req.params.id;
    if (!title && nameEn) title = nameEn;
    
    // Важно: берем threshold_eur, если нет - берем threshold, если нет - 0
    let finalThreshold = 0;
    if (threshold_eur !== undefined && threshold_eur !== null) finalThreshold = Number(threshold_eur);
    else if (threshold !== undefined && threshold !== null) finalThreshold = Number(threshold);
    
    if (!image_url && image) image_url = image;
    const is_active = (status === 'published') ? 1 : 0;
    
    const caseId = id || crypto.randomUUID();

    console.log(`💾 Saving Case: ${title} (Type: ${type}, Price: ${finalThreshold})`);

    await db.run("BEGIN TRANSACTION");
    await db.run(`
      INSERT INTO cases (id, title, type, threshold_eur, image_url, is_active) 
      VALUES (?, ?, ?, ?, ?, ?) 
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, type=excluded.type, threshold_eur=excluded.threshold_eur, image_url=excluded.image_url, is_active=excluded.is_active
    `, caseId, title, type, finalThreshold, image_url, is_active);
    
    // Обновляем содержимое кейса
    await db.run("DELETE FROM case_items WHERE case_id = ?", caseId);
    
    // Поддержка двух форматов items (items или contents)
    const itemsToSave = (items && items.length > 0) ? items : (contents || []);

    if (itemsToSave && Array.isArray(itemsToSave)) {
      for (const item of itemsToSave) {
        // Поддержка полей из админки (itemId vs item_id)
        const iId = item.item_id || item.itemId;
        const weight = item.weight || item.dropChance || 0;
        const rarity = item.rarity || 'common';
        
        if (iId) {
            await db.run(`INSERT INTO case_items (case_id, item_id, weight, rarity) VALUES (?, ?, ?, ?)`, caseId, iId, weight, rarity);
        }
      }
    }
    await db.run("COMMIT");
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
        await db.run("DELETE FROM case_items WHERE case_id = ?", req.params.id);
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

// PUBLIC CASE INFO (Для открытия)
app.get("/api/cases/:id", async (req, res) => {
    const { id } = req.params;
    const caseData = await db.get("SELECT * FROM cases WHERE id = ?", id);
    if (!caseData) return res.status(404).json({ error: "Case not found" });
    // Загружаем предметы
    const items = await db.all(`SELECT i.*, ci.weight, ci.rarity as drop_rarity FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ?`, id);
    
    // Считаем шансы
    const totalWeight = items.reduce((sum: number, i: any) => sum + i.weight, 0);
    const contents = items.map((i: any) => ({ 
        ...i, 
        chance: totalWeight > 0 ? (i.weight / totalWeight) * 100 : 0, 
        rarity: i.drop_rarity || i.rarity 
    }));
    
    res.json({ success: true, case: caseData, contents });
});

// OPEN CASE (С проверками и инвентарем)
app.post("/api/cases/open", requireSession, async (req, res) => {
    try {
        const { user_uuid } = res.locals.session;
        const { caseId } = req.body;
        
        console.log(`🎰 Attempting to open case ${caseId} for ${user_uuid}`);

        const caseMeta = await db.get("SELECT * FROM cases WHERE id = ?", caseId);
        if (!caseMeta) return res.status(404).json({ error: "Case not found" });
        
        // 1. Проверка доступности (Claim)
        // Для ежедневных кейсов ключ = ГГГГ-ММ-ДД, для месячных = ГГГГ-ММ
        const periodKey = (caseMeta.type && caseMeta.type.includes("daily")) ? getRigaDayKey() : getRigaMonthKey();
        
        const alreadyOpened = await db.get("SELECT id FROM case_claims WHERE user_uuid=? AND case_id=? AND period_key=?", user_uuid, caseId, periodKey);
        if (alreadyOpened) return res.status(400).json({ message: "Case already opened for this period" });

        // 2. Проверка депозита
        const progress = await calculateProgressSafe(user_uuid);
        const currentProgress = (caseMeta.type && caseMeta.type.includes("daily")) ? progress.daily : progress.monthly;
        
        if (currentProgress < caseMeta.threshold_eur) {
            return res.status(403).json({ message: `Not enough deposit. Need ${caseMeta.threshold_eur}, have ${currentProgress}` });
        }

        // 3. Выбор предмета (Рулетка)
        const caseItems = await db.all(`SELECT ci.*, i.stock, i.title, i.price_eur, i.sell_price_eur, i.type, i.image_url FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ?`, caseId);
        
        if (caseItems.length === 0) return res.status(500).json({ message: "Case is empty!" });

        const totalWeight = caseItems.reduce((acc: number, i: any) => acc + i.weight, 0);
        let rnd = Math.random() * totalWeight;
        const selected = caseItems.find((i: any) => (rnd -= i.weight) <= 0) || caseItems[0];
        
        const xpEarned = caseMeta.threshold_eur || 5; 
        
        // 4. Транзакция (Запись всего)
        await db.run("BEGIN TRANSACTION");
        // Записываем факт открытия
        await db.run(`INSERT INTO case_claims (user_uuid, case_id, period_key, claimed_at) VALUES (?, ?, ?, ?)`, user_uuid, caseId, periodKey, Date.now());
        // Начисляем XP
        await db.run(`INSERT INTO user_settings (user_uuid, xp) VALUES (?, ?) ON CONFLICT(user_uuid) DO UPDATE SET xp = xp + ?`, user_uuid, xpEarned, xpEarned);
        // Записываем спин (для Live Feed)
        await db.run(`INSERT INTO spins (user_uuid, case_id, period_key, prize_title, prize_amount_eur, rarity, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, user_uuid, caseId, getRigaDayKey(), selected.title, selected.price_eur, selected.rarity, selected.image_url, Date.now());
        // Добавляем в Инвентарь
        await db.run(`INSERT INTO inventory (user_uuid, item_id, title, type, image_url, amount_eur, sell_price_eur, rarity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`, user_uuid, selected.item_id, selected.title, selected.type, selected.image_url, selected.price_eur, selected.sell_price_eur, selected.rarity, Date.now(), Date.now());
        await db.run("COMMIT");

        console.log(`✅ Case opened! Prize: ${selected.title}`);
        // Возвращаем приз фронтенду для рулетки
        res.json({ 
            success: true, 
            item: { // Формат для CaseOpenPage
                id: selected.item_id,
                name: selected.title,
                type: selected.type,
                image: selected.image_url,
                rarity: selected.rarity,
                chance: (selected.weight / totalWeight) * 100
            },
            xpEarned 
        });

    } catch (e: any) { 
        console.error("OPEN CASE ERROR:", e);
        await db.run("ROLLBACK"); 
        res.status(500).json({ message: e.message }); 
    }
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

    // Заглушка начисления
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
    // Если деньги -> сразу начисляем
    if (item.type === 'money') {
        const amount = item.amount_eur || item.price_eur || 0;
        await addClientDeposit(user_uuid, amount);
        await db.run("UPDATE inventory SET status = 'received', updated_at = ? WHERE id = ?", Date.now(), inventory_id);
        await db.run("COMMIT");
        return res.json({ success: true, type: 'money', message: `Added ${amount}€ to balance` });
    }
    // Если скин -> проверяем трейд-ссылку
    if (item.type === 'skin' && !trade_link) {
        await db.run("ROLLBACK");
        return res.status(400).json({ error: "TRADE_LINK_MISSING" });
    }
    // Создаем заявку
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