import { Router } from "express";
import { SessionService } from "../services/SessionService";

const router = Router();

function getGqlUrl(): string {
  // Используем твой .env
  const url = process.env.SMARTSHELL_API_URL || process.env.SMARTSHELL_GRAPHQL_URL;
  if (!url) throw new Error("SMARTSHELL_API_URL is not set in .env");
  return url;
}

async function gqlRequest<T>(params: {
  query: string;
  variables?: any;
  accessToken?: string;
}): Promise<T> {
  const url = getGqlUrl();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (params.accessToken) {
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
    throw new Error(`SmartShell HTTP ${resp.status}: ${JSON.stringify(json).slice(0, 600)}`);
  }
  if (json.errors?.length) {
    throw new Error(`SmartShell GraphQL errors: ${JSON.stringify(json.errors).slice(0, 900)}`);
  }

  return json.data as T;
}

/**
 * POST /api/auth/session
 * Принимаем login/password от клиента (как в SmartShell) и создаём backend session_token.
 */
router.post("/session", async (req, res) => {
  try {
    const { login, password } = req.body as { login?: string; password?: string };

    if (!login || !password) {
      return res.status(400).json({
        ok: false,
        error: "LOGIN_PASSWORD_REQUIRED",
        message: "Provide login and password (same as SmartShell).",
      });
    }

    // 1) SmartShell: clientLogin
    const loginData = await gqlRequest<{
      clientLogin: {
        token_type: string;
        expires_in: number;
        access_token: string;
        refresh_token: string;
      };
    }>({
      query: `
        mutation ClientLogin($input: ClientLoginInput!) {
          clientLogin(input: $input) {
            token_type
            expires_in
            access_token
            refresh_token
          }
        }
      `,
      variables: { input: { login, password } },
    });

    const accessToken = loginData.clientLogin.access_token;

    // 2) SmartShell: clientMe (берём uuid/nickname/deposit)
    const meData = await gqlRequest<{
      clientMe: {
        uuid: string;
        nickname?: string | null;
        deposit?: any;
      };
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
      accessToken,
    });

    const clientUuid = meData.clientMe.uuid;
    const clientNickname = meData.clientMe.nickname ?? null;

    // 3) Создаём нашу backend-сессию и кладём внутрь smart_token
    const session = SessionService.create({
      clientUuid,
      clientNickname: clientNickname ?? undefined,
      smartToken: accessToken,
    });

    return res.status(200).json({
      ok: true,
      session_token: session.session_token,
      client: {
        uuid: clientUuid,
        nickname: clientNickname,
        deposit: meData.clientMe.deposit ?? null,
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: "SMARTSHELL_AUTH_FAILED",
      message: err?.message ?? "Unknown error",
    });
  }
});

export default router;
