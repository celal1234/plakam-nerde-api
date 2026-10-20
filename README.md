# Plakam Nerde? API

NestJS 12 + PostgreSQL 16/PostGIS + Redis. Tasarım: `ekip-plani/T6-teknik-sartname-v1.md`.

## Yerelde çalıştırma

```bash
cp .env.example .env
docker compose up -d db redis
pnpm install
pnpm start:dev          # açılışta migration'lar otomatik çalışır
curl localhost:3000/api/v1/health
```

Testler: `pnpm test` (birim), `pnpm test:e2e` (çalışan PostGIS + Redis ister).

## Coolify'a kurulum (Almanya sunucusu)

1. **Veritabanı:** Coolify → New Resource → Database → PostgreSQL. İmajı `postgis/postgis:16-3.5` yap. Zamanlanmış yedeği aç ve hedef olarak sunucudan ayrı bir S3 alanı seç.
2. **Redis:** New Resource → Database → Redis.
3. **API:** New Resource → GitHub reposu → Build Pack: Dockerfile. Port `3000`, Health Check yolu `/api/v1/health`.
4. **Ortam değişkenleri (API):** `DATABASE_URL` ve `REDIS_URL` için Coolify'ın verdiği iç bağlantı adreslerini kullan; `NODE_ENV=production`, `JWT_SECRET` (`openssl rand -base64 48`), `APP_URL`, `SMTP_URL`, `MAIL_FROM`, `CORS_ORIGINS` (web/admin alan adları). Tam liste: `.env.example`.
5. **Alan adı:** API'ye `https://api.<alan-adı>` ver; Coolify sertifikayı Let's Encrypt ile kendi alır.
6. Veritabanı ve Redis portlarını dışarıya açma (Coolify'da "Make it publicly available" kapalı kalsın).

## Hazır uçlar (`/api/v1`)

| Uç | Not |
|---|---|
| `GET /health` | Veritabanı bağlantısı |
| `POST /auth/register` · `/auth/verify-email` · `/auth/verify-email/resend` | Kayıt her durumda aynı yanıtı verir (e-posta varlığı sızmaz) |
| `POST /auth/login` · `/auth/refresh` · `/auth/logout` | Access JWT 15 dk; refresh 30 gün, her kullanımda yenilenir, tekrar kullanılırsa tüm zincir iptal |
| `POST /auth/password/forgot` · `/auth/password/reset` | Sıfırlama tüm oturumları kapatır |
| `GET/PATCH/DELETE /me` · `GET/PATCH /me/notification-prefs` | Silme kimlik bilgilerini hemen anonimleştirir |
| `POST /photos/upload-url` | 5 dk geçerli imzalı S3 yükleme adresi; JPEG/PNG/HEIC, en fazla 10 MB |
| `GET /plates/search?q=` | Üyeliksiz; IP başına dakikada 20; aktifler önce |
| `POST /plates` · `POST /plates/check-duplicate` | Yaklaşık konum 200–500 m kaydırılır; 2 km içinde aynı plaka uyarısı; resmî plaka onaya düşer |
| `GET /plates/{id}` · `PATCH /plates/{id}` (`If-Match: <version>`) | Kesin konum hiçbir herkese açık yanıtta yok |
| `POST /plates/{id}/extend` · `/close` · `/handover` · `GET /me/listings` | Tek uzatma, süre dolduktan en geç 30 gün sonra |

Henüz yok: Google/Apple girişi, telefon (`/me/phone`), cihaz token'ı (`/me/devices`), sızmış şifre kontrolü, fotoğraf işleme (EXIF silme, küçük resim; o zamana kadar `thumbUrl` null), zamanlanmış işler (süre dolumu şimdilik sorgu anında hesaplanıyor), teslim onayı, plaka alarmı.

## Yapı

- `src/database/migrations/` — şema değişiklikleri; yenisi `migrations/index.ts`'e eklenir.
- `src/common/errors/` — T6 §4 hata biçimi `{ error: { code, message, details } }`.
- `src/common/plate/` — plaka normalizasyonu ve esnek format kontrolü (T2).
