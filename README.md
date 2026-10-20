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

Testler: `pnpm test` (birim), `pnpm test:e2e` (çalışan PostGIS, Redis ve `localhost:3900`'da S3 uyumlu bir sunucu ister; örn. `docker run -p 3900:5000 motoserver/moto`).

Fotoğraf akışı: `POST /photos/upload-url` → telefon dosyayı imzalı adrese yükler → ilan yayınlanınca fotoğraf kuyruğa girer, JPEG/PNG olduğu doğrulanır, yeniden kodlanır (EXIF ve konum bilgisi düşer), 1600 px ve 400 px küçük resim üretilir, orijinal silinir. HEIC kabul edilmez; Flutter tarafı yüklemeden önce JPEG'e çevirir.

## Coolify'a kurulum (Almanya sunucusu)

1. **Veritabanı:** Coolify → New Resource → Database → PostgreSQL. İmajı `postgis/postgis:16-3.5` yap. Zamanlanmış yedeği aç ve hedef olarak sunucudan ayrı bir S3 alanı seç.
2. **Redis:** New Resource → Database → Redis.
3. **API:** New Resource → GitHub reposu → Build Pack: Dockerfile. Port `3000`, Health Check yolu `/api/v1/health`.
4. **Fotoğraf depolaması (Garage):** New Resource → Docker Image `dxflrs/garage:v2.4.1`. `deploy/garage/garage.toml` dosyasını `/etc/garage.toml` olarak bağla, `/var/lib/garage/meta` ve `/var/lib/garage/data` için kalıcı disk ekle, `GARAGE_RPC_SECRET` (`openssl rand -hex 32`) ve `GARAGE_ADMIN_TOKEN` ver. 3900 portunu Coolify'da `https://s3.<alan-adı>` olarak yayınla (telefonlar fotoğrafı doğrudan buraya yükler). Konteyner terminalinde bir kez:
   ```bash
   garage status                                   # düğüm kimliğini al
   garage layout assign -z dc1 -c 20G <düğüm-kimliği>
   garage layout apply --version 1
   garage bucket create plakam-photos
   garage key create plakam-api                    # çıkan Key ID ve Secret key'i sakla
   garage bucket allow --read --write plakam-photos --key plakam-api
   ```
5. **Ortam değişkenleri (API):** `DATABASE_URL` ve `REDIS_URL` için Coolify'ın verdiği iç bağlantı adreslerini kullan; `NODE_ENV=production`, `JWT_SECRET` (`openssl rand -base64 48`), `APP_URL`, `SMTP_URL`, `MAIL_FROM`, `CORS_ORIGINS` (web/admin alan adları), `S3_ENDPOINT=https://s3.<alan-adı>`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (yukarıdaki anahtar). Tam liste: `.env.example`.
6. **Alan adı:** API'ye `https://api.<alan-adı>` ver; Coolify sertifikayı Let's Encrypt ile kendi alır.
7. Veritabanı, Redis ve Garage yönetim portlarını dışarıya açma (Coolify'da "Make it publicly available" kapalı kalsın).

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

Henüz yok: Google/Apple girişi, telefon (`/me/phone`), cihaz token'ı (`/me/devices`), sızmış şifre kontrolü, zamanlanmış işler (süre dolumu şimdilik sorgu anında hesaplanıyor), teslim onayı, plaka alarmı.

## Yapı

- `src/database/migrations/` — şema değişiklikleri; yenisi `migrations/index.ts`'e eklenir.
- `src/common/errors/` — T6 §4 hata biçimi `{ error: { code, message, details } }`.
- `src/common/plate/` — plaka normalizasyonu ve esnek format kontrolü (T2).
