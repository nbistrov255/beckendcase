import axios from 'axios';
import https from 'https';
import { DateTime } from 'luxon';
import dotenv from 'dotenv';

dotenv.config();

type ClientTokens = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
};

export class SmartShellService {
  private apiUrl: string;
  private httpsAgent = new https.Agent({ rejectUnauthorized: false });

  // клубный токен (для hostsOverview и старого потока)
  private clubAccessToken: string | null = null;

  public TIMEZONE = 'Europe/Riga';
  private companyId = parseInt(process.env.SMARTSHELL_CLUB_ID || '6242');

  private clubCreds = {
    login: process.env.SMARTSHELL_LOGIN || '',
    password: process.env.SMARTSHELL_PASSWORD || '',
  };

  constructor() {
    this.apiUrl =
      process.env.SMARTSHELL_API_URL ||
      'https://billing.smartshell.gg/api/graphql';
  }

  // ---------------- низкоуровневый GraphQL POST ----------------
  private async post(query: string, variables: any, headers: Record<string, string>) {
    try {
      const resp = await axios.post(
        this.apiUrl,
        { query, variables },
        { headers, httpsAgent: this.httpsAgent }
      );
      return resp.data;
    } catch (e: any) {
      // Логируем ошибку SmartShell (чтобы видеть 422 и errors[])
      const status = e?.response?.status;
      const data = e?.response?.data;
      console.error('[SmartShell] GraphQL request failed:', { status, data });
      throw e;
    }
  }

  // ---------------- парс даты (фикс под dd.MM.yyyy HH:mm) ----------------
  private parseDate(dt: string): DateTime {
    const a = DateTime.fromISO(dt, { zone: this.TIMEZONE });
    if (a.isValid) return a;

    const b = DateTime.fromSQL(dt, { zone: this.TIMEZONE });
    if (b.isValid) return b;

    const c = DateTime.fromFormat(dt, 'dd.MM.yyyy HH:mm', { zone: this.TIMEZONE });
    if (c.isValid) return c;

    const d = DateTime.fromFormat(dt, 'dd.MM.yyyy HH:mm:ss', { zone: this.TIMEZONE });
    if (d.isValid) return d;

    const js = new Date(dt);
    if (!Number.isNaN(js.getTime())) return DateTime.fromJSDate(js).setZone(this.TIMEZONE);

    return DateTime.invalid('Unrecognized date format');
  }

  // ---------------- клубная авторизация (для старого pc_name потока) ----------------
  private async ensureClubAuth(): Promise<void> {
    if (this.clubAccessToken) return;

    const mutation = `
      mutation Login($input: LoginInput!) {
        login(input: $input) { access_token }
      }
    `;

    const data = await this.post(
      mutation,
      {
        input: {
          login: this.clubCreds.login,
          password: this.clubCreds.password,
          company_id: this.companyId,
        },
      },
      { 'Content-Type': 'application/json' }
    );

    const token = data?.data?.login?.access_token;
    if (!token) throw new Error('SmartShell club login failed');
    this.clubAccessToken = token;
  }

  private async clubQuery(query: string, variables: any = {}) {
    await this.ensureClubAuth();
    return this.post(query, variables, {
      Authorization: `Bearer ${this.clubAccessToken}`,
      'Content-Type': 'application/json',
      'x-club-id': this.companyId.toString(),
    });
  }

  // ---------------- CLIENT AUTH (для /api/auth/session) ----------------
  async clientLogin(login: string, password: string): Promise<ClientTokens | null> {
    const mutation = `
      mutation ClientLogin($input: ClientLoginInput!) {
        clientLogin(input: $input) {
          access_token
          refresh_token
          expires_in
        }
      }
    `;

    try {
      const data = await this.post(
        mutation,
        { input: { login, password } },
        {
          'Content-Type': 'application/json',
          'x-club-id': this.companyId.toString(),
        }
      );
      const t = data?.data?.clientLogin;
      if (!t?.access_token || !t?.refresh_token) return null;
      return t;
    } catch {
      return null;
    }
  }

  async clientMe(accessToken: string): Promise<{ uuid: string; nickname: string } | null> {
    const query = `
      query {
        clientMe {
          uuid
          nickname
        }
      }
    `;

    try {
      const data = await this.post(query, {}, {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'x-club-id': this.companyId.toString(),
      });
      const me = data?.data?.clientMe;
      if (!me?.uuid) return null;
      return { uuid: me.uuid, nickname: me.nickname || '' };
    } catch {
      return null;
    }
  }

  async clientRefreshToken(refresh_token: string): Promise<ClientTokens | null> {
    const mutation = `
      mutation ClientRefreshToken($input: ClientRefreshTokenInput!) {
        clientRefreshToken(input: $input) {
          access_token
          refresh_token
          expires_in
        }
      }
    `;

    try {
      const data = await this.post(
        mutation,
        { input: { refresh_token } },
        {
          'Content-Type': 'application/json',
          'x-club-id': this.companyId.toString(),
        }
      );
      const t = data?.data?.clientRefreshToken;
      if (!t?.access_token || !t?.refresh_token) return null;
      return t;
    } catch {
      return null;
    }
  }

  // ---------------- SUMS (НОВЫЙ ПУТЬ: клиентские платежи) ----------------
  // uuid тут не нужен, но оставлен чтобы не ломать сигнатуру вызова из index.ts
  async calcClientSums(
    clientAccessToken: string,
    _uuid: string
  ): Promise<{ dailySum: number; monthlySum: number }> {
    // ВАЖНО: если в SDK называется иначе (например getPaymentsByClientId) —
    // мы подстроим после того, как увидим ошибку/поле.
    const query = `
      query {
        clientPayments(first: 200) {
          data {
            amount
            created_at
            status
          }
        }
      }
    `;

    const data = await this.post(query, {}, {
      Authorization: `Bearer ${clientAccessToken}`,
      'Content-Type': 'application/json',
      'x-club-id': this.companyId.toString(),
    });

    const payments = data?.data?.clientPayments?.data || [];

    const now = DateTime.now().setZone(this.TIMEZONE);
    const startDay = now.startOf('day');
    const startMonth = now.startOf('month');

    let dailySum = 0;
    let monthlySum = 0;

    for (const p of payments) {
      if (p.status !== 'SUCCESS' && p.status !== 'COMPLETED') continue;

      const t = this.parseDate(String(p.created_at));
      if (!t.isValid) continue;

      const amount = Number(p.amount);
      if (Number.isNaN(amount)) continue;

      if (t >= startDay) dailySum += amount;
      if (t >= startMonth) monthlySum += amount;
    }

    return { dailySum, monthlySum };
  }

  // ---------------- СТАРЫЙ ПУТЬ (нужен, чтобы index.ts компилился) ----------------
  async getPlayerProfile(pcAlias: string) {
    // 1) Берём uuid+nickname по хосту (это у тебя точно работало)
    const hostsQuery = `
      query {
        hostsOverview {
          alias
          user { uuid nickname }
        }
      }
    `;

    const hostsResp = await this.clubQuery(hostsQuery);
    const hosts = hostsResp?.data?.hostsOverview || [];

    const host = hosts.find((h: any) =>
      String(h.alias).toLowerCase().includes(pcAlias.toLowerCase())
    );

    if (!host?.user?.uuid) return null;

    // 2) Попробуем посчитать суммы через клубный токен (если SmartShell разрешает).
    // Если вернёт 422 — НЕ валим сервер, просто возвращаем суммы 0 (старый путь для теста).
    let dailySum = 0;
    let monthlySum = 0;

    try {
      const paymentsQuery = `
        query GetPayments($uuid: String!) {
          user(uuid: $uuid) {
            payments(first: 50) {
              data { amount created_at status }
            }
          }
        }
      `;

      const payResp = await this.clubQuery(paymentsQuery, { uuid: host.user.uuid });
      const payments = payResp?.data?.user?.payments?.data || [];

      const now = DateTime.now().setZone(this.TIMEZONE);
      const startDay = now.startOf('day');
      const startMonth = now.startOf('month');

      for (const p of payments) {
        if (p.status !== 'SUCCESS' && p.status !== 'COMPLETED') continue;

        const t = this.parseDate(String(p.created_at));
        if (!t.isValid) continue;

        const amount = Number(p.amount);
        if (Number.isNaN(amount)) continue;

        if (t >= startDay) dailySum += amount;
        if (t >= startMonth) monthlySum += amount;
      }
    } catch (e) {
      console.error('[SmartShell] getPlayerProfile payments failed (ignored)');
    }

    return {
      uuid: host.user.uuid,
      nickname: host.user.nickname || '',
      dailySum,
      monthlySum,
    };
  }
}
