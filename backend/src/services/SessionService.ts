import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

export type SessionRow = {
  session_token: string;
  client_uuid: string;
  client_nickname: string | null;
  smart_token: string | null;
  created_at: number;
};

type Store = {
  sessions: SessionRow[];
};

const STORE_PATH = path.resolve(process.cwd(), "cyberhub.sessions.json");

function loadStore(): Store {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      const init: Store = { sessions: [] };
      fs.writeFileSync(STORE_PATH, JSON.stringify(init, null, 2), "utf-8");
      return init;
    }
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed.sessions) return { sessions: [] };
    return parsed;
  } catch {
    return { sessions: [] };
  }
}

function saveStore(store: Store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export class SessionService {
  /**
   * Создание backend-сессии (без БД, на файле)
   */
  static create(params: {
    clientUuid: string;
    clientNickname?: string;
    smartToken?: string;
  }): SessionRow {
    const store = loadStore();

    const session: SessionRow = {
      session_token: randomUUID(),
      client_uuid: params.clientUuid,
      client_nickname: params.clientNickname ?? null,
      smart_token: params.smartToken ?? null,
      created_at: Date.now(),
    };

    store.sessions.push(session);
    saveStore(store);

    return session;
  }

  /**
   * Получение сессии по токену
   */
  static getBySessionToken(token: string): SessionRow | null {
    const store = loadStore();
    const found = store.sessions.find((s) => s.session_token === token);
    return found ?? null;
  }

  /**
   * Удаление сессии
   */
  static delete(sessionToken: string): void {
    const store = loadStore();
    store.sessions = store.sessions.filter((s) => s.session_token !== sessionToken);
    saveStore(store);
  }
}
