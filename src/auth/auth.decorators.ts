import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export interface AuthUser {
  id: string;
  role: 'user' | 'admin';
  emailVerified: boolean;
  // Yalnızca TOTP ile doğrulanmış yönetici oturumlarında true (FR-057).
  mfa: boolean;
}

export const IS_PUBLIC = 'auth:public';
export const REQUIRES_VERIFIED_EMAIL = 'auth:verified';
export const ADMIN_ONLY = 'auth:admin';

// Oturum gerektirmeyen uçlar (ör. plaka arama, giriş).
export const Public = () => SetMetadata(IS_PUBLIC, true);
// İlan verme ve mesaj başlatma gibi uçlar için doğrulanmış e-posta şartı (FR-003).
export const RequireVerifiedEmail = () => SetMetadata(REQUIRES_VERIFIED_EMAIL, true);

// Yönetici uçları: rol veritabanından yeniden okunur; `mfa: false` yalnızca MFA kurulum/doğrulama uçları içindir.
export const AdminOnly = (opts: { mfa: boolean } = { mfa: true }) => SetMetadata(ADMIN_ONLY, opts);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
