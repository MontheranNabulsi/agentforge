import { z } from 'zod';
import { Id, Timestamp } from './common';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

const Password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

export const EmailInput = z.email().max(254);

export const RegisterInput = z.object({
  name: z.string().trim().min(1).max(80),
  email: EmailInput,
  password: Password,
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: EmailInput,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const UserDto = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  createdAt: Timestamp,
});
export type UserDto = z.infer<typeof UserDto>;

export const MeResponse = z.object({
  user: UserDto,
  session: z.object({ id: Id, expiresAt: Timestamp }),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const UpdateProfileInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  avatarUrl: z.url().max(500).nullable().optional(),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileInput>;

export const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: Password,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>;

export const PasswordResetRequestInput = z.object({ email: EmailInput });
export type PasswordResetRequestInput = z.infer<typeof PasswordResetRequestInput>;

export const PasswordResetConfirmInput = z.object({
  token: z.string().min(20).max(200),
  newPassword: Password,
});
export type PasswordResetConfirmInput = z.infer<typeof PasswordResetConfirmInput>;
