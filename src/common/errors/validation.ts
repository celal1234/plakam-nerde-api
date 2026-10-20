import { HttpStatus, ValidationError, ValidationPipe } from '@nestjs/common';
import { ApiError } from './api-error';

function collect(errors: ValidationError[], prefix = '', out: Record<string, string[]> = {}) {
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) out[path] = Object.keys(e.constraints);
    if (e.children?.length) collect(e.children, path, out);
  }
  return out;
}

export const validationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: (errors) =>
    new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Gönderilen bilgiler geçersiz.', {
      fields: collect(errors),
    }),
});
