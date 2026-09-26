import {
  ChangePasswordInput,
  LoginInput,
  MeResponse,
  OkResponse,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  RegisterInput,
  UpdateProfileInput,
  UserDto,
} from '@agentforge/contracts';
import type { FastifyRequest } from 'fastify';
import {
  clearSessionCookie,
  requireActor,
  setSessionCookie,
} from '../../../../platform/http/auth-context';
import type { App } from '../../../../platform/http/server';
import type { User } from '../../domain/identity-rules';
import type { ClientMeta, IdentityUseCases } from '../../application/identity-use-cases';

export const toUserDto = (user: User) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatarUrl: user.avatarUrl,
  createdAt: user.createdAt.toISOString(),
});

const clientMeta = (request: FastifyRequest): ClientMeta => ({
  ip: request.ip ?? null,
  userAgent: request.headers['user-agent'] ?? null,
});

const AUTH_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export function identityRoutes(deps: { identity: IdentityUseCases; cookieSecure: boolean }) {
  const { identity, cookieSecure } = deps;

  return async (api: App) => {
    api.post(
      '/auth/register',
      {
        schema: {
          tags: ['auth'],
          summary: 'Create an account and sign in',
          security: [],
          body: RegisterInput,
          response: { 201: MeResponse },
        },
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      },
      async (request, reply) => {
        const { user, session } = await identity.register(request.body, clientMeta(request));
        setSessionCookie(reply, session.token, session.expiresAt, cookieSecure);
        return reply.status(201).send({
          user: toUserDto(user),
          session: { id: session.id, expiresAt: session.expiresAt.toISOString() },
        });
      },
    );

    api.post(
      '/auth/login',
      {
        schema: {
          tags: ['auth'],
          summary: 'Sign in',
          security: [],
          body: LoginInput,
          response: { 200: MeResponse },
        },
        config: AUTH_RATE_LIMIT,
      },
      async (request, reply) => {
        const { user, session } = await identity.logIn(request.body, clientMeta(request));
        setSessionCookie(reply, session.token, session.expiresAt, cookieSecure);
        return {
          user: toUserDto(user),
          session: { id: session.id, expiresAt: session.expiresAt.toISOString() },
        };
      },
    );

    api.post(
      '/auth/logout',
      { schema: { tags: ['auth'], summary: 'Sign out' } },
      async (request, reply) => {
        if (request.auth) await identity.logOut(request.auth.session.id);
        clearSessionCookie(reply, cookieSecure);
        return reply.status(204).send();
      },
    );

    api.get(
      '/auth/me',
      { schema: { tags: ['auth'], summary: 'The signed-in user', response: { 200: MeResponse } } },
      async (request) => {
        const actor = requireActor(request);
        const user = await identity.getUser(actor.userId);
        return {
          user: toUserDto(user),
          session: {
            id: request.auth!.session.id,
            expiresAt: request.auth!.session.expiresAt.toISOString(),
          },
        };
      },
    );

    api.patch(
      '/auth/me',
      {
        schema: {
          tags: ['auth'],
          summary: 'Update your profile',
          body: UpdateProfileInput,
          response: { 200: UserDto },
        },
      },
      async (request) =>
        toUserDto(await identity.updateProfile(requireActor(request), request.body)),
    );

    api.post(
      '/auth/me/password',
      {
        schema: {
          tags: ['auth'],
          summary: 'Change your password (signs out other sessions)',
          body: ChangePasswordInput,
        },
        config: AUTH_RATE_LIMIT,
      },
      async (request, reply) => {
        await identity.changePassword(requireActor(request), request.body);
        return reply.status(204).send();
      },
    );

    api.post(
      '/auth/password-reset/request',
      {
        schema: {
          tags: ['auth'],
          summary: 'Email a password reset link (always answers the same way)',
          security: [],
          body: PasswordResetRequestInput,
          response: { 202: OkResponse },
        },
        config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      },
      async (request, reply) => {
        await identity.requestPasswordReset(request.body);
        return reply.status(202).send({ ok: true as const });
      },
    );

    api.post(
      '/auth/password-reset/confirm',
      {
        schema: {
          tags: ['auth'],
          summary: 'Set a new password with a reset token',
          security: [],
          body: PasswordResetConfirmInput,
        },
        config: AUTH_RATE_LIMIT,
      },
      async (request, reply) => {
        await identity.resetPassword(request.body);
        return reply.status(204).send();
      },
    );
  };
}
