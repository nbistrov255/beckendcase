import type { Request, Response, NextFunction } from "express";
import { SessionService } from "../services/SessionService";

/**
 * Express-паттерн: кладём авторизованный контекст в res.locals.session
 * ВАЖНО: здесь прокидываем smart_token из SessionService,
 * чтобы /api/me мог дергать SmartShell clientMe / payments.
 */

function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  return null;
}

export function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ ok: false, error: "NO_SESSION" });
  }

  const session = SessionService.getBySessionToken(token);

  if (!session) {
    return res.status(401).json({ ok: false, error: "INVALID_SESSION" });
  }

  res.locals.session = {
    token: session.session_token,
    client_uuid: session.client_uuid,
    client_nickname: session.client_nickname,
    smart_token: session.smart_token, // <-- КЛЮЧЕВОЕ
  };

  return next();
}
