import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthenticated } from '../../shared-kernel/errors';
import type { Actor } from '../../shared-kernel/ports';

export interface AuthContext {
  user: { id: string; email: string; name: string };
  session: { id: string; expiresAt: Date };
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export const SESSION_COOKIE = 'af_session';

/** The authenticated actor, or a 401 problem. Use in every handler that needs a user. */
export function requireActor(request: FastifyRequest): Actor {
  if (!request.auth) throw unauthenticated();
  return { userId: request.auth.user.id, sessionId: request.auth.session.id };
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  secure: boolean,
): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  void reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
}
