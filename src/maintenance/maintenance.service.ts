import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { MailService } from '../mail/mail.service';
import { RealtimeService } from '../realtime/realtime.service';
import { StorageService } from '../storage/storage.service';

const REMINDER_DAYS_BEFORE = 3;
const ORPHAN_PHOTO_HOURS = 24;
const AUDIT_RETENTION = '2 years'; // FR-056

// T6 §1'deki zamanlanmış işler. Her iş tekrar çalıştırılabilir (idempotent); aynı anda iki kopya
// çalışsa da aynı satırı iki kez işlemez.
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger('Maintenance');
  private readonly appUrl: string;

  constructor(
    private readonly db: DataSource,
    private readonly mail: MailService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeService,
    config: ConfigService,
  ) {
    this.appUrl = config.getOrThrow<string>('APP_URL');
  }

  // Saatlik: süresi dolan aktif ilanlar `expired` olur; kesin konum 90 gün sonra silinmek üzere işaretlenir.
  async expireListings(): Promise<number> {
    const rows: { id: string; owner_id: string }[] = await this.db.query(`
      WITH expired AS (
        UPDATE listings SET status = 'expired', version = version + 1, updated_at = now()
        WHERE status = 'active' AND expires_at <= now()
        RETURNING id, owner_id)
      SELECT * FROM expired`);
    if (rows.length) {
      await this.db.query(
        `UPDATE listing_private_location SET purge_after = now() + interval '90 days'
         WHERE listing_id = ANY($1::uuid[]) AND purge_after IS NULL`,
        [rows.map((r) => r.id)],
      );
      for (const r of rows) {
        await this.realtime.publish([r.owner_id], { type: 'listing.status', listingId: r.id, status: 'expired' });
      }
    }
    return rows.length;
  }

  // Günlük 09:00 (TSİ): süresi 3 gün içinde dolacak ilanların sahibine tek seferlik hatırlatma.
  async sendExpiryReminders(): Promise<number> {
    const rows: { id: string; email: string; plate_display: string; expires_at: Date; extended: boolean }[] =
      await this.db.query(
        `WITH due AS (
           UPDATE listings l SET expiry_reminded_at = now()
           FROM users u
           LEFT JOIN notification_prefs np ON np.user_id = u.id
           WHERE u.id = l.owner_id AND u.deleted_at IS NULL AND u.email IS NOT NULL
             AND COALESCE(np.expiry, true)
             AND l.status = 'active' AND l.expiry_reminded_at IS NULL
             AND l.expires_at > now() AND l.expires_at <= now() + make_interval(days => $1)
           RETURNING l.id, u.email, l.plate_display, l.expires_at, l.extended_at IS NOT NULL AS extended)
         SELECT * FROM due`,
        [REMINDER_DAYS_BEFORE],
      );
    for (const r of rows) {
      const date = r.expires_at.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
      const extendHint = r.extended
        ? 'İlan daha önce uzatıldığı için tekrar uzatılamaz; plaka sahibine ulaştıysanız ilanı kapatabilirsiniz.'
        : 'Plaka sahibi henüz ulaşmadıysa ilanı uygulamadan bir kez 30 gün uzatabilirsiniz.';
      await this.mail
        .send({
          to: r.email,
          subject: `${r.plate_display} ilanınızın süresi doluyor`,
          text: `${r.plate_display} plakalı ilanınız ${date} tarihinde yayından kalkacak.\n${extendHint}\n\n${this.appUrl}/ilan/${r.id}`,
        })
        .catch((e) => this.logger.warn(`hatırlatma gönderilemedi ${r.id}: ${(e as Error).message}`));
    }
    return rows.length;
  }

  // Günlük 03:00 (TSİ): saklama süreleri dolan kişisel veriler silinir.
  async purgeRetention(): Promise<Record<string, number>> {
    const count = async (sql: string) => {
      const rows: unknown[] = await this.db.query(`WITH d AS (${sql} RETURNING 1) SELECT 1 FROM d`);
      return rows.length;
    };
    return {
      // Kapanış veya süre dolumundan 90 gün sonra kesin konum.
      exactLocations: await count(`DELETE FROM listing_private_location WHERE purge_after < now()`),
      // Silinen hesapların yayında kalan ilanları kapatılır (FR-005).
      deletedOwnersListings: await count(`
        UPDATE listings SET status = 'closed', closed_reason = 'other', version = version + 1, updated_at = now()
        WHERE status IN ('active', 'pending') AND owner_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)`),
      // Süresi dolan plaka alarmları (FR-062: 90 gün).
      plateAlerts: await count(`DELETE FROM plate_alerts WHERE expires_at < now()`),
      authTokens: await count(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'`),
      refreshTokens: await count(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'`),
      auditLog: await count(`DELETE FROM audit_log WHERE created_at < now() - interval '${AUDIT_RETENTION}'`),
    };
  }

  // Günlük: yüklenip ilana bağlanmamış fotoğraflar 24 saat sonra silinir (BR-014).
  async purgeOrphanPhotos(): Promise<number> {
    // TypeORM, postgres'te DELETE için [satırlar, etkilenen sayı] döndürür.
    const [rows]: [{ id: string; storage_key: string; thumb_key: string | null }[], number] = await this.db.query(
      `DELETE FROM photos WHERE listing_id IS NULL AND created_at < now() - make_interval(hours => $1)
       RETURNING id, storage_key, thumb_key`,
      [ORPHAN_PHOTO_HOURS],
    );
    for (const p of rows) {
      for (const key of [p.storage_key, p.thumb_key]) {
        if (key) await this.storage.delete(key).catch(() => undefined); // yüklenmemiş nesne olabilir
      }
    }
    return rows.length;
  }
}
