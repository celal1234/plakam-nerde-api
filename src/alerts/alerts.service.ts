import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { ApiError } from '../common/errors/api-error';
import { normalizePlate } from '../common/plate/plate';
import { ALERTS, AlertJob } from '../queue/queue.module';

const ALERT_DAYS = 90;
const MAX_ACTIVE_ALERTS = 10;

const ALERT_COLUMNS = `id, plate_normalized AS plate, expires_at AS "expiresAt", created_at AS "createdAt"`;

// FR-062: "bu plaka için haber ver". Alarm 90 gün geçerlidir; aynı plakaya yeniden kurmak süreyi yeniler.
@Injectable()
export class AlertsService {
  constructor(
    private readonly db: DataSource,
    @Inject(ALERTS) private readonly queue: Queue<AlertJob>,
  ) {}

  list(userId: string) {
    return this.db.query(
      `SELECT ${ALERT_COLUMNS} FROM plate_alerts WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC`,
      [userId],
    );
  }

  async create(userId: string, plate: string) {
    const { normalized } = normalizePlate(plate);
    if (!normalized) throw new ApiError(HttpStatus.BAD_REQUEST, 'PLATE_REQUIRED', 'Plaka numarası girin.');

    return this.db.transaction(async (tx) => {
      // Aynı kullanıcının eşzamanlı isteklerinde sınır aşılmasın diye kullanıcı satırı kilitlenir.
      await tx.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const [{ n }]: { n: number }[] = await tx.query(
        `SELECT count(*)::int AS n FROM plate_alerts WHERE user_id = $1 AND expires_at > now() AND plate_normalized <> $2`,
        [userId, normalized],
      );
      if (n >= MAX_ACTIVE_ALERTS) {
        throw new ApiError(HttpStatus.CONFLICT, 'ALERT_LIMIT_REACHED', `En fazla ${MAX_ACTIVE_ALERTS} plaka alarmı kurabilirsiniz.`);
      }
      const [row] = await tx.query(
        `INSERT INTO plate_alerts (user_id, plate_normalized, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3))
         ON CONFLICT (user_id, plate_normalized) DO UPDATE SET expires_at = EXCLUDED.expires_at
         RETURNING ${ALERT_COLUMNS}`,
        [userId, normalized, ALERT_DAYS],
      );
      return row;
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const [rows]: [unknown[], number] = await this.db.query(`DELETE FROM plate_alerts WHERE id = $1 AND user_id = $2 RETURNING id`, [
      id,
      userId,
    ]);
    if (!rows.length) throw new ApiError(HttpStatus.NOT_FOUND, 'ALERT_NOT_FOUND', 'Alarm bulunamadı.');
  }

  // İlan yayına girdiğinde (oluşturma veya yönetici onayı) çağrılır; eşleşme ve e-posta kuyrukta yapılır.
  async listingPublished(listingId: string): Promise<void> {
    await this.queue.add('notify', { listingId }, { jobId: `listing-${listingId}` });
  }
}
