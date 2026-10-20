import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { ApiError } from './api-error';

const DEFAULT_CODES: Record<number, [string, string]> = {
  400: ['VALIDATION_FAILED', 'İstek geçersiz.'],
  401: ['AUTH_REQUIRED', 'Bu işlem için giriş yapmalısınız.'],
  403: ['FORBIDDEN', 'Bu işlem için yetkiniz yok.'],
  404: ['NOT_FOUND', 'Kayıt bulunamadı.'],
  429: ['RATE_LIMITED', 'Çok fazla istek gönderdiniz, biraz sonra tekrar deneyin.'],
};

// Her hatayı `{ error: { code, message, details } }` biçimine çevirir (T6 §4).
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();

    if (exception instanceof ApiError) {
      res.status(exception.getStatus()).json({
        error: { code: exception.code, message: exception.message, details: exception.details },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const [code, message] = DEFAULT_CODES[status] ?? ['ERROR', exception.message];
      res.status(status).json({ error: { code, message } });
      return;
    }

    const requestId = randomUUID();
    this.logger.error(`${req.method} ${req.url} requestId=${requestId}`, (exception as Error)?.stack);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL', message: 'Beklenmeyen bir hata oluştu.', details: { requestId } },
    });
  }
}
