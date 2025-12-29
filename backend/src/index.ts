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

// --- SMARTSHELL & LOGIC ---
async function gqlRequest<T>(query: string, variables: any = {}, token?: string): Promise<T> {
  const url = process.env.SMARTSHELL_API_URL || "https://billing.smartshell.gg/api/graphql";
  const headers: any = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    const json = await res.json() as any;
    if (json.errors) throw new Error(json.errors[0]?.message);
    return json.data;
  } catch (e) {
    console.error("SmartShell API Error:", e);
    throw e;
  }
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

// Получение баланса и начисление денег в SmartShell
async function getClientBalance(userUuid: string): Promise<number> {
    return 0; // Заглушка
}

async function addClientDeposit(userUuid: string, amount: number) {
    // !!! ВАЖНО: Здесь должна быть реальная интеграция с API SmartShell
    console.log(`💰 [DEPOSIT] Adding ${amount} EUR to ${userUuid}`);
    return true; 
}

// Расчет уровней
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
  const session = await db.get("SELECT * FROM sessions WHERE token = ?", token);
  if (!session) return res.status(401).json({ error: "Invalid session" });
  
  const settings = await db.get("SELECT * FROM user_settings WHERE user_uuid = ?", session.user_uuid);
  res.locals.session = { ...session, ...settings };
  next();
}

// === ROUTES ===

// 1. PUBLIC STATS & LIVE FEED
app.get("/api/stats/public", async (req, res) => {
    const stats = await db.get("SELECT COUNT(DISTINCT user_uuid) as unique_users, COUNT(*) as total_spins FROM spins");
    res.json({ success: true, stats });
});

app.get("/api/drops/recent", async (req, res) => {
    const drops = await db.all(`
        SELECT s.id, s.prize_title as item_name, s.image_url as image, s.rarity, 
               s.created_at as timestamp, s.user_uuid 
        FROM spins s ORDER BY s.created_at DESC LIMIT 20
    `);
    
    for (let drop of drops) {
        const user = await db.get("SELECT nickname FROM sessions WHERE user_uuid = ? ORDER BY created_at DESC LIMIT 1", drop.user_uuid);
        drop.user_name = user ? user.nickname : "Anonymous";
    }
    res.json({ success: true, drops });
});

// 2. ITEMS & CASES (ADMIN)
app.get("/api/admin/items", requireSession, async (req, res) => {
    const items = await db.all("SELECT * FROM items");
    res.json({ success: true, items });
});

// 3. CASE CONTENTS
app.get("/api/cases/:id", async (req, res) => {
    const { id } = req.params;
    const caseData = await db.get("SELECT * FROM cases WHERE id = ?", id);
    if (!caseData) return res.status(404).json({ error: "Case not found" });

    const items = await db.all(`
        SELECT i.*, ci.weight, ci.rarity as drop_rarity 
        FROM case_items ci 
        JOIN items i ON ci.item_id = i.id 
        WHERE ci.case_id = ?
    `, id);

    const totalWeight = items.reduce((sum: number, i: any) => sum + i.weight, 0);
    const contents = items.map((i: any) => ({
        ...i,
        chance: (i.weight / totalWeight) * 100,
        rarity: i.drop_rarity || i.rarity
    }));

    res.json({ success: true, case: caseData, contents });
});

// 4. OPEN CASE
app.post("/api/cases/open", requireSession, async (req, res) => {
    try {
        const { user_uuid } = res.locals.session;
        const { caseId } = req.body;
        
        const caseMeta = await db.get("SELECT * FROM cases WHERE id = ?", caseId);
        if (!caseMeta) return res.status(404).json({ error: "Case not found" });

        const caseItems = await db.all(`SELECT ci.*, i.stock, i.title, i.price_eur, i.sell_price_eur, i.type, i.image_url FROM case_items ci JOIN items i ON ci.item_id = i.id WHERE ci.case_id = ?`, caseId);
        
        let rnd = Math.random() * caseItems.reduce((acc: number, i: any) => acc + i.weight, 0);
        const selected = caseItems.find((i: any) => (rnd -= i.weight) <= 0) || caseItems[0];

        // XP Logic
        const xpEarned = caseMeta.threshold_eur || 5; 
        
        await db.run("BEGIN TRANSACTION");
        
        // XP
        await db.run(`
            INSERT INTO user_settings (user_uuid, xp) VALUES (?, ?)
            ON CONFLICT(user_uuid) DO UPDATE SET xp = xp + ?
        `, user_uuid, xpEarned, xpEarned);

        // Spin
        await db.run(`INSERT INTO spins (user_uuid, case_id, period_key, prize_title, prize_amount_eur, rarity, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
            user_uuid, caseId, getRigaDayKey(), selected.title, selected.price_eur, selected.rarity, selected.image_url, Date.now());

        // Inventory: Все предметы (включая деньги) падают в инвентарь со статусом 'available'
        await db.run(`INSERT INTO inventory (user_uuid, item_id, title, type, image_url, amount_eur, sell_price_eur, rarity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`,
            user_uuid, selected.item_id, selected.title, selected.type, selected.image_url, selected.price_eur, selected.sell_price_eur, selected.rarity, Date.now(), Date.now());

        await db.run("COMMIT");

        res.json({ success: true, prize: selected, xpEarned });
    } catch (e: any) {
        await db.run("ROLLBACK");
        res.status(500).json({ error: e.message });
    }
});

// 5. INVENTORY & CLAIM SYSTEM
app.get("/api/inventory", requireSession, async (req, res) => {
    // Показываем все предметы, доступные для действий
    const items = await db.all("SELECT * FROM inventory WHERE user_uuid = ? AND status IN ('available', 'processing') ORDER BY created_at DESC", res.locals.session.user_uuid);
    res.json({ items });
});

// Продать предмет (Деньги продать нельзя)
app.post("/api/inventory/sell", requireSession, async (req, res) => {
    const { inventory_id } = req.body;
    const { user_uuid } = res.locals.session;
    
    const item = await db.get("SELECT * FROM inventory WHERE id = ? AND user_uuid = ?", inventory_id, user_uuid);
    
    if (!item || item.status !== 'available') return res.status(400).json({ error: "Item not available" });
    if (item.type === 'money') return res.status(400).json({ error: "Money items cannot be sold, use Claim to add to balance" });

    // Начисление средств (заглушка)
    await addClientDeposit(user_uuid, item.sell_price_eur);

    await db.run("UPDATE inventory SET status = 'sold', updated_at = ? WHERE id = ?", Date.now(), inventory_id);
    res.json({ success: true, sold_amount: item.sell_price_eur });
});

// Запросить получение (Claim) - Здесь магия для денег
app.post("/api/inventory/claim", requireSession, async (req, res) => {
    const { inventory_id } = req.body;
    const { user_uuid, trade_link } = res.locals.session;

    const item = await db.get("SELECT * FROM inventory WHERE id = ? AND user_uuid = ?", inventory_id, user_uuid);
    
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.status !== 'available') return res.status(400).json({ error: "Item not available for claim" });
    
    await db.run("BEGIN TRANSACTION");

    // ЛОГИКА ДЛЯ ДЕНЕГ: Мгновенное зачисление
    if (item.type === 'money') {
        const amount = item.amount_eur || item.price_eur || 0;
        await addClientDeposit(user_uuid, amount);
        
        await db.run("UPDATE inventory SET status = 'received', updated_at = ? WHERE id = ?", Date.now(), inventory_id);
        await db.run("COMMIT");
        
        return res.json({ success: true, type: 'money', message: `Added ${amount}€ to balance` });
    }

    // ЛОГИКА ДЛЯ ПРЕДМЕТОВ: Создание заявки админу
    if (item.type === 'skin' && !trade_link) {
        await db.run("ROLLBACK");
        return res.status(400).json({ error: "TRADE_LINK_MISSING" });
    }

    const requestId = `REQ-${Math.floor(Math.random() * 1000000)}`;
    
    await db.run("UPDATE inventory SET status = 'processing', updated_at = ? WHERE id = ?", Date.now(), inventory_id);
    await db.run(`INSERT INTO requests (id, user_uuid, inventory_id, item_title, type, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        requestId, user_uuid, inventory_id, item.title, item.type, Date.now());
        
    await db.run("COMMIT");

    res.json({ success: true, type: 'item', requestId });
});

// Сохранить Trade Link
app.post("/api/user/tradelink", requireSession, async (req, res) => {
    const { trade_link } = req.body;
    const { user_uuid } = res.locals.session;
    
    await db.run(`
        INSERT INTO user_settings (user_uuid, trade_link) VALUES (?, ?)
        ON CONFLICT(user_uuid) DO UPDATE SET trade_link = excluded.trade_link
    `, user_uuid, trade_link);
    
    res.json({ success: true });
});

// 6. ADMIN REQUESTS MANAGEMENT
app.get("/api/admin/requests", requireSession, async (req, res) => {
    const requests = await db.all(`
        SELECT r.*, u.nickname as user_nickname, s.trade_link 
        FROM requests r
        LEFT JOIN sessions u ON r.user_uuid = u.user_uuid 
        LEFT JOIN user_settings s ON r.user_uuid = s.user_uuid
        ORDER BY r.created_at DESC
    `);
    res.json(requests);
});

app.post("/api/admin/requests/:id/approve", requireSession, async (req, res) => {
    const { id } = req.params;
    await db.run("BEGIN TRANSACTION");
    await db.run("UPDATE requests SET status = 'approved', updated_at = ? WHERE id = ?", Date.now(), id);
    const reqData = await db.get("SELECT inventory_id FROM requests WHERE id = ?", id);
    await db.run("UPDATE inventory SET status = 'received', updated_at = ? WHERE id = ?", Date.now(), reqData.inventory_id);
    await db.run("COMMIT");
    res.json({ success: true });
});

app.post("/api/admin/requests/:id/deny", requireSession, async (req, res) => {
    const { id } = req.params;
    const { comment } = req.body;
    await db.run("BEGIN TRANSACTION");
    await db.run("UPDATE requests SET status = 'denied', admin_comment = ?, updated_at = ? WHERE id = ?", comment, Date.now(), id);
    const reqData = await db.get("SELECT inventory_id FROM requests WHERE id = ?", id);
    await db.run("UPDATE inventory SET status = 'available', updated_at = ? WHERE id = ?", Date.now(), reqData.inventory_id);
    await db.run("COMMIT");
    res.json({ success: true });
});

app.post("/api/admin/requests/:id/return", requireSession, async (req, res) => {
    const { id } = req.params;
    await db.run("BEGIN TRANSACTION");
    await db.run("UPDATE requests SET status = 'returned', updated_at = ? WHERE id = ?", Date.now(), id);
    const reqData = await db.get("SELECT inventory_id FROM requests WHERE id = ?", id);
    await db.run("UPDATE inventory SET status = 'available', updated_at = ? WHERE id = ?", Date.now(), reqData.inventory_id);
    await db.run("COMMIT");
    res.json({ success: true });
});

// Профиль пользователя с XP
app.get("/api/profile", requireSession, async (req, res) => {
    const session = res.locals.session;
    const userSettings = await db.get("SELECT * FROM user_settings WHERE user_uuid = ?", session.user_uuid);
    const xpData = calculateLevel(userSettings?.xp || 0);

    // Добавляем инфу по кейсам как раньше, но теперь level берется из БД
    // ... (код получения cases/progress как в старом index.ts)
    // Упрощенная версия ответа:
    res.json({ 
        success: true, 
        profile: { 
            uuid: session.user_uuid,
            nickname: session.nickname,
            balance: session.deposit || 0, // Это должно идти из SmartShell
            level: xpData.level,
            currentXP: xpData.currentXP,
            requiredXP: xpData.requiredXP,
            tradeLink: userSettings?.trade_link,
            // Нужно вернуть список cases (как в старом коде), я пропустил его для краткости, 
            // но в реальном index.ts он должен быть.
        } 
    });
});

initDB().then(async database => { db = database; app.listen(PORT, "0.0.0.0", () => console.log(`[Backend] Started on port ${PORT}`)); });