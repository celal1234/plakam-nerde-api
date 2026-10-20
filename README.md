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
5. **Ortam değişkenleri (API):** `DATABASE_URL` ve `REDIS_URL` için Coolify'ın verdiği iç bağlantı adreslerini kullan; `NODE_ENV=production`, `JWT_SECRET` (`openssl rand -base64 48`), `APP_URL`, `SMTP_URL`, `MAIL_FROM`, `CORS_ORIGINS` (web/admin alan adları), `S3_ENDPOINT=https://s3.<alan-adı>`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (yukarıdaki anahtar), `DATA_ENCRYPTION_KEY` (`openssl rand -base64 32`; yönetici MFA sırrı ve ileride telefon numarası bununla şifrelenir, **kaybedilir veya değiştirilirse eski kayıtlar çözülemez**, Coolify dışında da güvenli bir yerde sakla). Tam liste: `.env.example`.
6. **Alan adı:** API'ye `https://api.<alan-adı>` ver; Coolify sertifikayı Let's Encrypt ile kendi alır.
7. Veritabanı, Redis ve Garage yönetim portlarını dışarıya açma (Coolify'da "Make it publicly available" kapalı kalsın).
8. **İlk yönetici:** Uygulamadan normal hesap aç ve e-postanı doğrula, sonra API konteynerinin terminalinde `node dist/cli/admin.js grant <e-posta>`. Panelde ilk girişte `POST /admin/mfa/setup` ile verilen QR'ı doğrulama uygulamasına (Google Authenticator, Authy, 1Password) ekle ve kodu `POST /admin/mfa/verify` ile gir. Telefonunu kaybeden yönetici için `node dist/cli/admin.js reset-mfa <e-posta>`, yetkiyi almak için `revoke`.

## Hazır uçlar (`/api/v1`)

| Uç | Not |
|---|---|
| `GET /health` | Veritabanı bağlantısı |
| `POST /auth/register` · `/auth/verify-email` · `/auth/verify-email/resend` | Kayıt her durumda aynı yanıtı verir (e-posta varlığı sızmaz) |
| `POST /auth/login` · `/auth/refresh` · `/auth/logout` | Access JWT 15 dk; refresh 30 gün, her kullanımda yenilenir, tekrar kullanılırsa tüm zincir iptal |
| `POST /auth/password/forgot` · `/auth/password/reset` | Sıfırlama tüm oturumları kapatır |
| `GET/PATCH/DELETE /me` · `GET/PATCH /me/notification-prefs` | Silme kimlik bilgilerini hemen anonimleştirir |
| `GET/PATCH/DELETE /me/phone` | İsteğe bağlı Türkiye numarası (`0532…`, `+90 532…` kabul edilir). AES-256-GCM ile şifreli saklanır, yanıtta yalnız son 4 hane. `DATA_ENCRYPTION_KEY` gerekir |
| `POST /photos/upload-url` | 5 dk geçerli imzalı S3 yükleme adresi; JPEG/PNG (HEIC'i uygulama yüklemeden önce JPEG'e çevirir), en fazla 10 MB |
| `GET /plates/search?q=` | Üyeliksiz; IP başına dakikada 20; aktifler önce |
| `POST /plates` · `POST /plates/check-duplicate` | Yaklaşık konum 200–500 m kaydırılır; 2 km içinde aynı plaka uyarısı; resmî plaka onaya düşer |
| `GET /plates/{id}` · `PATCH /plates/{id}` (`If-Match: <version>`) | Kesin konum hiçbir herkese açık yanıtta yok. Numara detayda yok, yalnız `hasPhone` |
| `GET /plates/{id}/phone` | Giriş gerekir. İlan sahibi "telefonum görünsün" demişse ve ilan aktifse numarayı verir; kullanıcı başına günde 20, engelleşen kullanıcılara verilmez |
| `POST /plates/{id}/extend` · `/close` · `/handover` · `GET /me/listings` | Tek uzatma, süre dolduktan en geç 30 gün sonra |
| `POST/GET /conversations` · `GET/POST /conversations/{id}/messages` · `POST /conversations/{id}/read` | Aynı ilana ikinci başlatma aynı konuşmayı döner; `clientId` ile tekrar gönderim çift kayıt açmaz; konumu yalnızca ilan sahibi paylaşır; dakikada 20 mesaj, günde 20 yeni konuşma |
| `POST /plates/{id}/handover-confirm` | Teslim konuşmasının arayan tarafı 7 gün içinde bir kez; "hayır" yönetici incelemesine düşer |
| `POST /users/{id}/block` | İki yönde de yazışmayı kapatır |
| `GET/POST /me/alerts` · `DELETE /me/alerts/{id}` | Plaka alarmı: 90 gün geçerli, aynı plakaya yeniden kurmak süreyi yeniler, en fazla 10. Doğrulanmış e-posta gerekir. Aynı plakaya ilan yayına girince (resmî plakada yönetici onayıyla) alarm sahibine bir kez e-posta gider; kendi ilanına ve "plaka alarmı" bildirimi kapalı olana gitmez. Push (FCM) gelince oraya da gidecek |
| `POST /reports` | İlan, kullanıcı veya konuşma şikâyeti; aynı şeye ikinci kez 409; günde 20. Bir ilan 3 farklı kullanıcıdan açık şikâyet alınca yönetici kararına kadar gizlenir (eşik `settings.report_hide_threshold`) |
| `wss://…/api/v1/ws` | İlk mesaj `{"type":"auth","token":"<access JWT>"}`; yanıt `{"type":"ready"}`. Olaylar: `message.new`, `message.read`. Kopunca `GET …/messages?after=<sonId>` ile eşitlenir |

Zamanlanmış işler (BullMQ, Türkiye saati, `WORKER_ENABLED=true` olan kopyada): `expire-listings` saatlik, `expiry-reminders` 09:00 (süre bitmeden 3 gün önce tek e-posta), `retention-purge` 03:00 (90 günü dolan kesin konumlar, silinen hesapların ilanları, eski token'lar, 2 yılı geçen denetim kayıtları, süresi dolan plaka alarmları), `orphan-photos` 03:30 (24 saatte ilana bağlanmayan fotoğraflar).

### Yönetici uçları (`/api/v1/admin`)

Hepsi yönetici rolü **ve** MFA'lı oturum ister (yoksa 403 `ADMIN_ONLY` / `ADMIN_MFA_REQUIRED`). Rol her istekte veritabanından okunur. MFA'lı oturum 12 saat geçerli, sonra panel kodu yeniden ister. Tüm işlemler ve kişisel veri görüntülemeleri `audit_log`'a IP ile yazılır.

| Uç | Not |
|---|---|
| `POST /admin/mfa/setup` · `POST /admin/mfa/verify` `{code}` | Yalnız rol yeterli. Kurulum 10 dk içinde doğrulanmalı; doğrulama MFA'lı yeni token çifti döner; aynı kod iki kez geçmez; 5 dakikada 5 deneme |
| `GET /admin/listings?plate=&status=&city=&from=&to=&limit=&offset=` · `GET /admin/listings/{id}` | `status`: pending, active, handed_over, closed, expired, removed, hidden. Plaka baştan eşleşir. Ayrıntıda fotoğraflar ve şikâyetler |
| `POST /admin/listings/{id}/approve` · `/reject` `{reason}` · `/remove` `{reason}` | Onayda süre o andan başlar. Ret/kaldırmada sebep sahibine e-postayla gider; kaldırılan ilanın konuşmaları salt okunur olur, açık şikâyetleri kapanır |
| `GET /admin/reports?status=open` · `POST /admin/reports/{id}/resolve` `{action, days?, note?}` | `none` (gizleme eşiğin altına inerse kalkar), `remove_listing`, `restrict_user` (kullanıcı, ilan sahibi veya konuşmadaki karşı taraf) |
| `POST /admin/users/{id}/restrict` `{days: 1\|7\|30\|null}` · `/unrestrict` | `null` süresiz. Kısıtlı kullanıcı ilan veremez, konuşma başlatamaz, mesaj yazamaz; arama serbest. Kullanıcıya e-posta gider |
| `GET /admin/listings/{id}/exact-location` · `GET /admin/users/{id}/phone` | Her çağrı denetim kaydına yazılır |
| `GET /admin/metrics?from=&to=` | Varsayılan son 30 gün: günlük yeni ilan, arama, sonuç bulunan arama ve oranı, teslim. Arama metni saklanmaz, yalnızca sayılır |

Panel arayüzü ayrı bir web işi; ayrı alt alan adında (`admin.<alan-adı>`) yayınlanması ve `CORS_ORIGINS`'e eklenmesi yeterli.

Henüz yok: push bildirimi (FCM), Google/Apple girişi, cihaz token'ı (`/me/devices`), sızmış şifre kontrolü.

## Yapı

- `src/database/migrations/` — şema değişiklikleri; yenisi `migrations/index.ts`'e eklenir.
- `src/common/errors/` — T6 §4 hata biçimi `{ error: { code, message, details } }`.
- `src/common/plate/` — plaka normalizasyonu ve esnek format kontrolü (T2).
