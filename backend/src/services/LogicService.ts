import { Database } from 'sqlite';
import { DateTime } from 'luxon';

type CaseType = 'daily' | 'monthly';

export class LogicService {
  constructor(private db: Database) {}

  // =========================
  // Проверка: можно ли открыть
  // =========================
  async canClaim(
    user_uuid: string,
    case_id: string,
    type: CaseType
  ): Promise<boolean> {
    const now = DateTime.now().setZone('Europe/Riga');
    const claimedAt =
      type === 'daily'
        ? now.toISODate()
        : now.toFormat('yyyy-MM');

    const row = await this.db.get(
      `
      SELECT 1 FROM case_claims
      WHERE user_uuid = ? AND case_id = ? AND claimed_at = ?
      `,
      [user_uuid, case_id, claimedAt]
    );

    return !row;
  }

  // =========================
  // Список кейсов для профиля
  // =========================
  async getCasesForUser(
    user_uuid: string,
    dailySum: number,
    monthlySum: number
  ) {
    const dailyThresholds = [3, 10];
    const monthlyThresholds = [25, 50, 75, 100, 150];

    const cases: any[] = [];

    for (const t of dailyThresholds) {
      const id = `daily_${t}`;
      const available =
        dailySum >= t &&
        (await this.canClaim(user_uuid, id, 'daily'));

      cases.push({
        id,
        type: 'daily',
        threshold: t,
        available,
        progress: dailySum,
      });
    }

    for (const t of monthlyThresholds) {
      const id = `monthly_${t}`;
      const available =
        monthlySum >= t &&
        (await this.canClaim(user_uuid, id, 'monthly'));

      cases.push({
        id,
        type: 'monthly',
        threshold: t,
        available,
        progress: monthlySum,
      });
    }

    return cases;
  }

  // =========================
  // Открытие кейса
  // =========================
  async openCase(user_uuid: string, case_id: string) {
    const [type, value] = case_id.split('_');
    const threshold = Number(value);

    if (!['daily', 'monthly'].includes(type)) {
      return { success: false, error: 'INVALID_CASE' };
    }

    const now = DateTime.now().setZone('Europe/Riga');
    const claimedAt =
      type === 'daily'
        ? now.toISODate()
        : now.toFormat('yyyy-MM');

    const already = await this.db.get(
      `
      SELECT 1 FROM case_claims
      WHERE user_uuid = ? AND case_id = ? AND claimed_at = ?
      `,
      [user_uuid, case_id, claimedAt]
    );

    if (already) {
      return { success: false, error: 'ALREADY_CLAIMED' };
    }

    // ⚠️ Призы пока не делаем — просто фиксируем открытие
    await this.db.run(
      `
      INSERT INTO case_claims (user_uuid, case_id, claimed_at)
      VALUES (?, ?, ?)
      `,
      [user_uuid, case_id, claimedAt]
    );

    return {
      success: true,
      prize: {
        type: 'stub',
        value: 0,
        message: 'Case opened (prize logic next step)',
      },
    };
  }
}
