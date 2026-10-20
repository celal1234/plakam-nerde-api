import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { MailService } from '../mail/mail.service';
import { ALERT_QUEUE, AlertJob, QUEUE_CONNECTION } from '../queue/queue.module';

interface Recipient {
  alert_id: string;
  email: string;
}

// FR-062 / AC-18: yayına giren ilanın plakasına alarm kurmuş kullanıcılara e-posta. Push (FCM) gelince buraya eklenecek.
// E-postada konum ve fotoğraf yok; yalnız plaka ve ilan bağlantısı.
@Injectable()
export class AlertsProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('AlertsProcessor');
  private worker?: Worker<AlertJob>;
  private readonly appUrl: string;

  constructor(
    private readonly db: DataSource,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
  ) {
    this.appUrl = config.getOrThrow<string>('APP_URL');
  }

  onModuleInit() {
    if (this.config.get('WORKER_ENABLED') !== true) return;
    this.worker = new Worker<AlertJob>(ALERT_QUEUE, (job) => this.process(job.data.listingId), {
      connection: this.connection.duplicate(),
    });
    this.worker.on('failed', (job, err) => this.logger.warn(`alarm ${job?.data.listingId} deneme ${job?.attemptsMade}: ${err.message}`));
  }

  async onApplicationShutdown() {
    await this.worker?.close();
  }

  async process(listingId: string): Promise<number> {
    const [listing]: { plate_display: string; plate_normalized: string; owner_id: string }[] = await this.db.query(
      `SELECT plate_display, plate_normalized, owner_id FROM listings
       WHERE id = $1 AND status = 'active' AND expires_at > now() AND NOT hidden_by_reports`,
      [listingId],
    );
    if (!listing) return 0;

    const recipients: Recipient[] = await this.db.query(
      `SELECT a.id AS alert_id, u.email
       FROM plate_alerts a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN notification_prefs p ON p.user_id = a.user_id
       WHERE a.plate_normalized = $1 AND a.expires_at > now() AND a.user_id <> $2
         AND u.deleted_at IS NULL AND u.email IS NOT NULL AND COALESCE(p.plate_alert, true)`,
      [listing.plate_normalized, listing.owner_id],
    );

    let sent = 0;
    for (const r of recipients) {
      // Önce teslim kaydı: yeniden denemede aynı kişiye ikinci e-posta gitmez. Gönderim başarısızsa kayıt geri alınır.
      const claimed: unknown[] = await this.db.query(
        `INSERT INTO plate_alert_deliveries (alert_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`,
        [r.alert_id, listingId],
      );
      if (!claimed.length) continue;
      try {
        await this.mail.send({
          to: r.email,
          subject: `${listing.plate_display} plakası için yeni ilan`,
          text:
            `Alarm kurduğunuz ${listing.plate_display} plakası için yeni bir ilan açıldı. Plakanın sizin olup olmadığını ilandaki fotoğraftan kontrol edebilirsiniz:\n` +
            `${this.appUrl}/ilan/${listingId}\n\n` +
            `Bu bildirimleri uygulamada Ayarlar > Bildirimler bölümünden kapatabilirsiniz.`,
        });
        sent++;
      } catch (e) {
        await this.db.query(`DELETE FROM plate_alert_deliveries WHERE alert_id = $1 AND listing_id = $2`, [r.alert_id, listingId]);
        throw e;
      }
    }
    return sent;
  }
}
