import { HttpException } from '@nestjs/common';

// T6 §4: istemci `code`'a göre davranır, `message` kullanıcıya gösterilecek Türkçe metindir.
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }
}
