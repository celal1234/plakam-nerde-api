import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiError } from '../common/errors/api-error';
import { AuthUser, IS_PUBLIC, REQUIRES_VERIFIED_EMAIL } from './auth.decorators';

interface AccessPayload {
  sub: string;
  role: AuthUser['role'];
  ev: boolean;
}

// Uygulama genelinde varsayılan olarak açık; `@Public()` olmayan her uç Bearer token ister.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED', 'Bu işlem için giriş yapmalısınız.');
    }

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(header.slice(7));
    } catch (e) {
      const expired = (e as Error).name === 'TokenExpiredError';
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        expired ? 'TOKEN_EXPIRED' : 'AUTH_REQUIRED',
        expired ? 'Oturumunuzun süresi doldu.' : 'Bu işlem için giriş yapmalısınız.',
      );
    }

    const user: AuthUser = { id: payload.sub, role: payload.role, emailVerified: payload.ev };
    req.user = user;

    if (this.reflector.getAllAndOverride<boolean>(REQUIRES_VERIFIED_EMAIL, targets) && !user.emailVerified) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'EMAIL_NOT_VERIFIED', 'Önce e-posta adresinizi doğrulayın.');
    }
    return true;
  }
}
