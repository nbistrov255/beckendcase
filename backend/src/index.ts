import express from "express";
import cors from "cors";
import authRouter from "./routes/auth";
import { requireSession } from "./middleware/requireSession";
import { initDB } from "./database";

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// --- helpers: timezone Riga ---
const RIGA_TZ = "Europe/Riga";

function rigaDateParts(now = new Date()): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: RIGA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  return { y, m, d };
}

function rigaYMD(now = new Date()): string {
  const { y, m, d } = rigaDateParts(now);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function rigaYM(now = new Date()): string {
  const { y, m } = rigaDateParts(now);
  return `${y}-${String(m).padStart(2, "0")}`;
}

function secondsUntilNextRigaMidnight(now = new Date()): number {
  const { y, m, d } = rigaDateParts(now);
  const today0 = new Date(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00`);
  const next0 = new Date(today0.getTime() + 24 * 60 * 60 * 1000);
  const diffMs = next0.getTime() - now.getTime();
  return Math.max(0, Math.floor(diffMs / 1000));
}

function secondsUntilNextMonthRiga(now = new Date()): number {
  const { y, m } = rigaDateParts(now);
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  const nextMonthStart = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00`);
  const diffMs = nextMonthStart.getTime() - now.getTime();
  return Math.max(0, Math.floor(diffMs / 1000));
}

/**
 * created_at нормализуем в "YYYY-MM-DD"
 * поддерживаем форматы:
 * - "YYYY-MM-DD HH:MM:SS"
 * - "YYYY-MM-DDTHH:MM:SS..."
 * - "DD.MM.YYYY HH:MM"
 * - "DD.MM.YYYY"
 */
function normalizeDatePart(createdAt: string): string | null {
  if (!createdAt) return null;
  const s = String(createdAt).trim();

  // YYYY-MM-DD...
  const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;

  // DD.MM.YYYY...
  const m2 = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;

  const first = s.split(" ")[0]?.trim();
  if (first && first !== s) return normalizeDatePart(first);

  return null;
}

// --- SmartShell GraphQL helpers ---
function getGqlUrl(): string {
  const url = process.env.SMARTSHELL_API_URL || process.env.SMARTSHELL_GRAPHQL_URL;
  if (!url) throw new Error("SMARTSHELL_API_URL is not set in .env");
  return url;
}

async function gqlRequest<T>(params: { query: string; variables?: any; accessToken?: string }): Promise<T> {
  const url = getGqlUrl();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (params.accessToken && params.accessToken.trim().length > 0) {
    headers["Authorization"] = `Bearer ${params.accessToken}`;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: params.query,
      variables: params.variables ?? {},
    }),
  });

  const json = (await resp.json()) as any;

  if (!resp.ok) {
    throw new Error(`SmartShell HTTP ${resp.status}: ${JSON.stringify(json).slice(0, 2000)}`);
  }
  if (json.errors?.length) {
    throw new Error(`SmartShell GraphQL errors: ${JSON.stringify(json.errors).slice(0, 4000)}`);
  }

  return json.data as T;
}

/**
 * SERVICE TOKEN (организация) — нужен для getPaymentsByClientId
 */
let serviceAccessToken: string | null = null;
let serviceAccessTokenExpiresAt = 0;

async function getServiceToken(): Promise<string> {
  const now = Date.now();
  if (serviceAccessToken && now < serviceAccessTokenExpiresAt) return serviceAccessToken;

  const login = process.env.SMARTSHELL_LOGIN;
  const password = process.env.SMARTSHELL_PASSWORD;
  const companyIdRaw = process.env.SMARTSHELL_CLUB_ID;

  if (!login || !password || !companyIdRaw) {
    throw new Error("Missing env: SMARTSHELL_LOGIN / SMARTSHELL_PASSWORD / SMARTSHELL_CLUB_ID");
  }

  const company_id = Number(companyIdRaw);
  if (!Number.isFinite(company_id)) {
    throw new Error("SMARTSHELL_CLUB_ID must be a number (company_id)");
  }

  const data = await gqlRequest<{
    login: { access_token: string; expires_in: number; token_type: string; refresh_token?: string };
  }>({
    query: `
      mutation Login($input: LoginInput!) {
        login(input: $input) {
          token_type
          expires_in
          access_token
          refresh_token
        }
      }
    `,
    variables: { input: { login, password, company_id } },
  });

  const token = data?.login?.access_token;
  const expiresIn = Number(data?.login?.expires_in ?? 0);

  if (!token) throw new Error("Service login did not return access_token");

  const ttlMs = Math.max(60, expiresIn - 60) * 1000;
  serviceAccessToken = token;
  serviceAccessTokenExpiresAt = Date.now() + ttlMs;

  console.log(`[SmartShell] service token refreshed, expires_in=${expiresIn}s`);
  return token;
}

// --- contract: cases list ---
type CaseDef = {
  id: string;
  type: "daily" | "monthly";
  threshold_eur: number;
  title: string;
  available: boolean;
  remaining_today?: number;
  remaining_month?: number;
};

function buildCases(dailyEur: number, monthlyEur: number): CaseDef[] {
  const dailyDefs: Array<Omit<CaseDef, "available">> = [
    { id: "daily_3", type: "daily", threshold_eur: 3, title: "Daily Case 3€", remaining_today: 1 },
    { id: "daily_10", type: "daily", threshold_eur: 10, title: "Daily Case 10€", remaining_today: 1 },
    { id: "daily_20", type: "daily", threshold_eur: 20, title: "Daily Case 20€", remaining_today: 1 },
  ];

  const monthlyDefs: Array<Omit<CaseDef, "available">> = [
    { id: "monthly_30", type: "monthly", threshold_eur: 30, title: "Monthly Case 30€", remaining_month: 1 },
    { id: "monthly_50", type: "monthly", threshold_eur: 50, title: "Monthly Case 50€", remaining_month: 1 },
    { id: "monthly_75", type: "monthly", threshold_eur: 75, title: "Monthly Case 75€", remaining_month: 1 },
    { id: "monthly_100", type: "monthly", threshold_eur: 100, title: "Monthly Case 100€", remaining_month: 1 },
    { id: "monthly_150", type: "monthly", threshold_eur: 150, title: "Monthly Case 150€", remaining_month: 1 },
  ];

  const daily = dailyDefs.map((c) => ({ ...c, available: dailyEur >= c.threshold_eur }));
  const monthly = monthlyDefs.map((c) => ({ ...c, available: monthlyEur >= c.threshold_eur }));

  return [...daily, ...monthly];
}

// ---- helpers: payments ----
function isDepositTopup(it: any): boolean {
  const itemTypes: string[] = Array.isArray(it?.items)
    ? it.items.map((x: any) => String(x?.type ?? "").toUpperCase()).filter(Boolean)
    : [];
  if (itemTypes.includes("DEPOSIT")) return true;

  const title = String(it?.title ?? "").toLowerCase();
  if (title.includes("пополнение") && title.includes("депозит")) return true;

  return false;
}

/**
 * Финальное правило суммы для DEPOSIT:
 * - используем sum (в твоих данных sum=3)
 * - fallback: amount
 */
function getDepositValueEur(it: any): number {
  const sum = Number(it?.sum ?? 0);
  if (Number.isFinite(sum) && sum > 0) return sum;

  const amount = Number(it?.amount ?? 0);
  if (Number.isFinite(amount) && amount > 0) return amount;

  return 0;
}

/**
 * Определяем поле отмены/возврата через “попробовать запросить поле”.
 */
type PaymentsQueryResult = {
  items: any[];
  cancelField: string | null;
};

function looksLikeUnknownFieldError(msg: string): boolean {
  const s = msg.toLowerCase();
  return s.includes("cannot query field") || s.includes("unknown argument") || s.includes("unknown type");
}

async function fetchPaymentsSmart(uuid: string, serviceToken: string): Promise<PaymentsQueryResult> {
  const baseFields = `
    created_at
    title
    amount
    sum
    paymentMethod
    items { id type }
  `;

  const candidates: Array<{ field: string }> = [
    { field: "is_refunded" },
    { field: "is_canceled" },
    { field: "is_cancelled" },
    { field: "status" },
  ];

  for (const c of candidates) {
    try {
      const data = await gqlRequest<any>({
        query: `
          query GetPaymentsByClientId($uuid: String!, $page: Int, $first: Int) {
            getPaymentsByClientId(uuid: $uuid, page: $page, first: $first) {
              data {
                ${baseFields}
                ${c.field}
              }
            }
          }
        `,
        variables: { uuid, page: 1, first: 200 },
        accessToken: serviceToken,
      });

      const items = data?.getPaymentsByClientId?.data ?? [];
      console.log(`[SmartShell] payments cancel-field detected: ${c.field}`);
      return { items, cancelField: c.field };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (looksLikeUnknownFieldError(msg)) continue;
      throw e;
    }
  }

  const data = await gqlRequest<any>({
    query: `
      query GetPaymentsByClientId($uuid: String!, $page: Int, $first: Int) {
        getPaymentsByClientId(uuid: $uuid, page: $page, first: $first) {
          data {
            ${baseFields}
          }
        }
      }
    `,
    variables: { uuid, page: 1, first: 200 },
    accessToken: serviceToken,
  });

  const items = data?.getPaymentsByClientId?.data ?? [];
  console.log(`[SmartShell] payments cancel-field NOT available (no known field)`);
  return { items, cancelField: null };
}

function isCanceledPayment(it: any, cancelField: string | null): boolean {
  if (!cancelField) return false;

  const v = (it as any)[cancelField];

  if (typeof v === "boolean") return v === true;
  if (typeof v === "number") return v === 1;

  if (typeof v === "string") {
    const s = v.toUpperCase();
    if (s.includes("CANCEL") || s.includes("CANCELED") || s.includes("CANCELLED")) return true;
    if (s.includes("REFUND") || s.includes("REFUNDED")) return true;
    if (s.includes("VOID")) return true;
  }

  return false;
}

async function computeTopups(uuid: string): Promise<{ dailyTopupEur: number; monthlyTopupEur: number }> {
  const todayYMD = rigaYMD(new Date());
  const monthYM = rigaYM(new Date());

  let dailyTopupEur = 0;
  let monthlyTopupEur = 0;

  const serviceToken = await getServiceToken();
  const { items, cancelField } = await fetchPaymentsSmart(uuid, serviceToken);

  for (const it of items) {
    const datePart = normalizeDatePart(it?.created_at);
    if (!datePart) continue;

    if (!isDepositTopup(it)) continue;
    if (isCanceledPayment(it, cancelField)) continue;

    const value = getDepositValueEur(it);
    if (value <= 0) continue;

    const monthPart = datePart.slice(0, 7);
    if (datePart === todayYMD) dailyTopupEur += value;
    if (monthPart === monthYM) monthlyTopupEur += value;
  }

  dailyTopupEur = Math.round(dailyTopupEur * 100) / 100;
  monthlyTopupEur = Math.round(monthlyTopupEur * 100) / 100;

  return { dailyTopupEur, monthlyTopupEur };
}

// --- cases config for open ---
type CaseCfg = { id: string; type: "daily" | "monthly"; threshold_eur: number; title: string };

const CASE_CONFIGS: CaseCfg[] = [
  { id: "daily_3", type: "daily", threshold_eur: 3, title: "Daily Case 3€" },
  { id: "daily_10", type: "daily", threshold_eur: 10, title: "Daily Case 10€" },
  { id: "daily_20", type: "daily", threshold_eur: 20, title: "Daily Case 20€" },
  { id: "monthly_30", type: "monthly", threshold_eur: 30, title: "Monthly Case 30€" },
  { id: "monthly_50", type: "monthly", threshold_eur: 50, title: "Monthly Case 50€" },
  { id: "monthly_75", type: "monthly", threshold_eur: 75, title: "Monthly Case 75€" },
  { id: "monthly_100", type: "monthly", threshold_eur: 100, title: "Monthly Case 100€" },
  { id: "monthly_150", type: "monthly", threshold_eur: 150, title: "Monthly Case 150€" },
];

function getCaseConfig(caseId: string): CaseCfg | null {
  return CASE_CONFIGS.find((c) => c.id === caseId) || null;
}

// --- prize picker (MVP: cash only) ---
type Prize = {
  id: string;
  typen* Error: Unable to compile TypeScript:
src/index.ts(365,55): error TS2561: Object literal may only specify known properties, but 'titlez' does not exist in type 'CaseCfg'. Did you mean to write 'title'? 
    type: "cash";
  title: string;
  amount_eur: number;
  meta?: Record<string, any> | null;
  weight: number;
};

const PRIZES_BY_CASE: Record<string, Prize[]> = {
  daily_3: [
    { id: "cash_025", type: "cash", title: "Cash 0.25€", amount_eur: 0.25, weight: 40 },
    { id: "cash_050", type: "cash", title: "Cash 0.50€", amount_eur: 0.5, weight: 30 },
    { id: "cash_075", type: "cash", title: "Cash 0.75€", amount_eur: 0.75, weight: 20 },
    { id: "cash_100", type: "cash", title: "Cash 1.00€", amount_eur: 1.0, weight: 10 },
  ],
  daily_10: [
    { id: "cash_050", type: "cash", title: "Cash 0.50€", amount_eur: 0.5, weight: 30 },
    { id: "cash_100", type: "cash", title: "Cash 1.00€", amount_eur: 1.0, weight: 30 },
    { id: "cash_200", type: "cash", title: "Cash 2.00€", amount_eur: 2.0, weight: 20 },
    { id: "cash_300", type: "cash", title: "Cash 3.00€", amount_eur: 3.0, weight: 15 },
    { id: "cash_500", type: "cash", title: "Cash 5.00€", amount_eur: 5.0, weight: 5 },
  ],
  daily_20: [
    { id: "cash_100", type: "cash", title: "Cash 1.00€", amount_eur: 1.0, weight: 25 },
    { id: "cash_200", type: "cash", title: "Cash 2.00€", amount_eur: 2.0, weight: 25 },
    { id: "cash_300", type: "cash", title: "Cash 3.00€", amount_eur: 3.0, weight: 20 },
    { id: "cash_400", type: "cash", title: "Cash 4.00€", amount_eur: 4.0, weight: 20 },
    { id: "cash_1000", type: "cash", title: "Cash 10.00€", amount_eur: 10.0, weight: 10 },
  ],
};

function pickPrize(caseId: string) {
  const prizes = PRIZES_BY_CASE[caseId] || PRIZES_BY_CASE["daily_3"];
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of prizes) {
    r -= p.weight;
    if (r <= 0) return { id: p.id, type: p.type, title: p.title, amount_eur: p.amount_eur, meta: p.meta ?? null };
  }
  const last = prizes[prizes.length - 1];
  return { id: last.id, type: last.type, title: last.title, amount_eur: last.amount_eur, meta: last.meta ?? null };
}

// health-check
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "cyberhub_api" });
});

// auth
app.use("/api/auth", authRouter);

/**
 * /api/me
 */
app.get("/api/me", requireSession, async (_req, res) => {
  const s = res.locals.session as
    | { token: string; client_uuid: string; client_nickname: string | null; smart_token?: string | null }
    | undefined;

  if (!s) return res.status(500).json({ ok: false, error: "SESSION_CONTEXT_MISSING" });

  const clientSmartToken = (s.smart_token ?? null) as string | null;

  // ---- 1) deposit из clientMe (клиентский токен) ----
  let depositEur: number | null = null;

  if (clientSmartToken) {
    try {
      const meData = await gqlRequest<{
        clientMe: { uuid: string; nickname?: string | null; deposit?: any };
      }>({
        query: `
          query ClientMe {
            clientMe {
              uuid
              nickname
              deposit
            }
          }
        `,
        accessToken: clientSmartToken,
      });

      const dep = meData.clientMe.deposit;
      if (typeof dep === "number") depositEur = dep;
      else if (typeof dep === "string") {
        const n = Number(dep);
        depositEur = Number.isFinite(n) ? n : null;
      } else if (dep && typeof dep === "object") {
        const maybeAmount = (dep as any).amount ?? (dep as any).value ?? null;
        const n = Number(maybeAmount);
        depositEur = Number.isFinite(n) ? n : null;
      }
    } catch {
      depositEur = null;
    }
  }

  let dailyTopupEur = 0;
  let monthlyTopupEur = 0;

  try {
    const r = await computeTopups(s.client_uuid);
    dailyTopupEur = r.dailyTopupEur;
    monthlyTopupEur = r.monthlyTopupEur;
  } catch (e: any) {
    console.error("getPaymentsByClientId error:", e?.message || e);
    dailyTopupEur = 0;
    monthlyTopupEur = 0;
  }

  const cases = buildCases(dailyTopupEur, monthlyTopupEur);

  return res.status(200).json({
    ok: true,
    user: {
      uuid: s.client_uuid,
      nickname: s.client_nickname,
      deposit_eur: depositEur,
    },
    progress: {
      daily_topup_eur: dailyTopupEur,
      monthly_topup_eur: monthlyTopupEur,
    },
    timers: {
      daily_reset_seconds: secondsUntilNextRigaMidnight(new Date()),
      monthly_reset_seconds: secondsUntilNextMonthRiga(new Date()),
      timezone: RIGA_TZ,
    },
    cases,
  });
});

// --- DB & /api/cases/open ---
let db: any = null;

app.post("/api/cases/open", requireSession, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: "DB_NOT_READY" });

    const s = res.locals.session as
      | { token: string; client_uuid: string; client_nickname: string | null; smart_token?: string | null }
      | undefined;

    if (!s) return res.status(500).json({ ok: false, error: "SESSION_CONTEXT_MISSING" });

    const case_id = String(req.body?.case_id || "").trim();
    if (!case_id) return res.status(400).json({ ok: false, error: "CASE_ID_REQUIRED" });

    const cfg = getCaseConfig(case_id);
    if (!cfg) return res.status(404).json({ ok: false, error: "CASE_NOT_FOUND" });

    const { dailyTopupEur, monthlyTopupEur } = await computeTopups(s.client_uuid);
    const current = cfg.type === "daily" ? dailyTopupEur : monthlyTopupEur;

    if (current < cfg.threshold_eur) {
      return res.status(403).json({
        ok: false,
        error: "CASE_NOT_AVAILABLE",
        details: { required_eur: cfg.threshold_eur, current_eur: current, type: cfg.type },
      });
    }

    // period key (Riga): daily => YYYY-MM-DD, monthly => YYYY-MM
    const now = new Date();
    const { y, m, d } = rigaDateParts(now);
    const periodKey =
      cfg.type === "daily"
        ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
        : `${y}-${String(m).padStart(2, "0")}`;

    // anti-repeat
    const already = await db.get(
      `SELECT id FROM case_claims WHERE user_uuid = ? AND case_id = ? AND claimed_at = ? LIMIT 1`,
      s.client_uuid,
      case_id,
      periodKey
    );
    if (already) return res.status(409).json({ ok: false, error: "ALREADY_OPENED" });

    const prize = pickPrize(case_id);
    const createdAt = Date.now();

    await db.exec("BEGIN");
    try {
      await db.run(
        `INSERT INTO case_claims (user_uuid, case_id, claimed_at) VALUES (?, ?, ?)`,
        s.client_uuid,
        case_id,
        periodKey
      );

      const spinRes = await db.run(
        `INSERT INTO spins (
          user_uuid, case_id, period_key,
          prize_type, prize_title, prize_amount_eur, prize_meta_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        s.client_uuid,
        case_id,
        periodKey,
        prize.type,
        prize.title,
        prize.amount_eur ?? null,
        prize.meta ? JSON.stringify(prize.meta) : null,
        createdAt
      );

      const spinId = spinRes.lastID;

      const invRes = await db.run(
        `INSERT INTO inventory (
          user_uuid, spin_id,
          prize_type, title, amount_eur, meta_json,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        s.client_uuid,
        spinId,
        prize.type,
        prize.title,
        prize.amount_eur ?? null,
        prize.meta ? JSON.stringify(prize.meta) : null,
        createdAt,
        createdAt
      );

      await db.exec("COMMIT");

      return res.status(200).json({
        ok: true,
        spin: { id: spinId, case_id, period_key: periodKey, created_at: createdAt },
        prize,
        inventory: { id: invRes.lastID, status: "PENDING" },
      });
    } catch (e: any) {
      await db.exec("ROLLBACK");
      const msg = String(e?.message || e);
      if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("uq_case_claims")) {
        return res.status(409).json({ ok: false, error: "ALREADY_OPENED" });
      }
      console.error("openCase DB error:", msg);
      return res.status(500).json({ ok: false, error: "DB_ERROR" });
    }
  } catch (e: any) {
    console.error("CASE_OPEN_ERROR", e?.message || e);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

initDB()
  .then((database) => {
    db = database;

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[cyberhub_api] listening on http://0.0.0.0:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[DB] init failed", err);
    process.exit(1);
  });
