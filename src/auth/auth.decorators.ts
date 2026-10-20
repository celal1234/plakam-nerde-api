import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export interface AuthUser {
  id: string;
  role: 'user' | 'admin';
  emailVerified: boolean;
}

export const IS_PUBLIC = 'auth:public';
export const REQUIRES_VERIFIED_EMAIL = 'auth:verified';

// Oturum gerektirmeyen uçlar (ör. plaka arama, giriş).
export const Public = () => SetMetadata(IS_PUBLIC, true);
// İlan verme ve mesaj başlatma gibi uçlar için doğrulanmış e-posta şartı (FR-003).
export const RequireVerifiedEmail = () => SetMetadata(REQUIRES_VERIFIED_EMAIL, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
