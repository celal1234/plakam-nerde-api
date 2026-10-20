import { applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { TokenPair, TokenResponse } from './auth.dto';
import { REFRESH_TTL_DAYS } from './auth.service';

// Tarayıcı istemcileri (web, panel) refresh token'ı JavaScript'in okuyamadığı httpOnly cookie'de taşır.
// İstek bu başlıkla gelirse token gövdede dönmez, cookie'ye yazılır; refresh ve logout da cookie'den okur.
// Cookie yalnızca başlık varken okunur: özel başlık CORS ön kontrolünü zorunlu kıldığı için
// `CORS_ORIGINS` dışındaki bir site tarayıcıdaki cookie'yle istek attıramaz (CSRF).
const HEADER = 'X-Token-Transport';
const COOKIE = 'refresh_token';
const cookieOptions: CookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/api/v1/auth' };

export const TokenTransportHeader = () =>
  applyDecorators(
    ApiHeader({
      name: HEADER,
      required: false,
      enum: ['cookie'],
      description: 'Tarayıcıda `cookie`: refresh token gövde yerine httpOnly cookie ile taşınır',
    }),
  );

const wantsCookie = (req: Request) => req.get(HEADER) === 'cookie';

function readCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

// Cookie modunda gövdedeki değer yok sayılır; böylece token yalnızca tek bir yoldan gelir.
export const refreshTokenFrom = (req: Request, bodyToken: string | undefined): string | undefined =>
  wantsCookie(req) ? readCookie(req) : bodyToken;

export function sendTokens(req: Request, res: Response, { accessToken, refreshToken }: TokenPair): TokenResponse {
  if (!wantsCookie(req)) return { accessToken, refreshToken };
  res.cookie(COOKIE, refreshToken, { ...cookieOptions, maxAge: REFRESH_TTL_DAYS * 86400_000 });
  return { accessToken };
}

export function clearRefreshCookie(req: Request, res: Response): void {
  if (wantsCookie(req)) res.clearCookie(COOKIE, cookieOptions);
}
