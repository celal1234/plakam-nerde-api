// T6 §4 hata gövdesi; OpenAPI'de her uca `default` yanıtı olarak eklenir.
export class ApiErrorBody {
  // İstemci davranışı buna göre seçer (ör. `VALIDATION_FAILED`, `LISTING_NOT_FOUND`).
  code: string;
  // Kullanıcıya gösterilecek Türkçe metin.
  message: string;
  // `VALIDATION_FAILED`'da `fields`, 429'da `retryAfter`, 500'de `requestId`.
  details?: Record<string, unknown>;
}

export class ApiErrorResponse {
  error: ApiErrorBody;
}
