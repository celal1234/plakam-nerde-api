import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../auth/auth.decorators';
import { audit } from '../common/audit/audit';
import { ApiError } from '../common/errors/api-error';
import { RateLimiter } from '../common/rate-limit/rate-limiter.service';
import { CreatedReport, CreateReportDto } from './reports.dto';

const invalidTarget = () =>
  new ApiError(HttpStatus.BAD_REQUEST, 'REPORT_INVALID_TARGET', 'Şikâyet edilecek ilan, kullanıcı veya konuşma bulunamadı.');

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DataSource,
    private readonly limiter: RateLimiter,
  ) {}

  async create(user: AuthUser, dto: CreateReportDto): Promise<CreatedReport> {
    const targets = [dto.listingId, dto.userId, dto.conversationId].filter(Boolean);
    if (targets.length !== 1) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'İlan, kullanıcı veya konuşmadan yalnızca biri seçilmeli.', {
        fields: { target: ['exactly_one'] },
      });
    }
    await this.limiter.consume(`report:${user.id}`, 20, 86400);

    return this.db.transaction(async (tx) => {
      let targetUserId: string | null = dto.userId ?? null;
      if (dto.listingId) {
        const [l]: { owner_id: string }[] = await tx.query(
          `SELECT owner_id FROM listings WHERE id = $1 AND status NOT IN ('pending', 'removed')`,
          [dto.listingId],
        );
        if (!l || l.owner_id === user.id) throw invalidTarget();
      } else if (dto.userId) {
        const [u] = await tx.query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`, [dto.userId]);
        if (!u || dto.userId === user.id) throw invalidTarget();
      } else {
        // Konuşma şikâyeti karşı tarafı hedef alır; yönetici kısıtlamayı ona uygular.
        const [c]: { other: string }[] = await tx.query(
          `SELECT CASE WHEN owner_id = $2 THEN seeker_id ELSE owner_id END AS other
           FROM conversations WHERE id = $1 AND (owner_id = $2 OR seeker_id = $2)`,
          [dto.conversationId, user.id],
        );
        if (!c) throw invalidTarget();
        targetUserId = c.other;
      }

      if (!dto.listingId) {
        const [dup] = await tx.query(
          `SELECT 1 FROM reports WHERE reporter_id = $1 AND status = 'open'
             AND target_user_id IS NOT DISTINCT FROM $2 AND conversation_id IS NOT DISTINCT FROM $3`,
          [user.id, targetUserId, dto.conversationId ?? null],
        );
        if (dup) throw alreadyReported();
      }

      const rows: { id: string; createdAt: Date }[] = await tx.query(
        `INSERT INTO reports (reporter_id, listing_id, target_user_id, conversation_id, reason, note)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (reporter_id, listing_id) WHERE listing_id IS NOT NULL DO NOTHING
         RETURNING id, created_at AS "createdAt"`,
        [user.id, dto.listingId ?? null, targetUserId, dto.conversationId ?? null, dto.reason, dto.note ?? null],
      );
      if (!rows.length) throw alreadyReported();

      if (dto.listingId) await this.hideIfThresholdReached(tx, dto.listingId);
      return { id: rows[0].id, status: 'open', createdAt: rows[0].createdAt };
    });
  }

  // FR-072: farklı kullanıcılardan gelen açık şikâyet sayısı eşiğe ulaşınca ilan yönetici kararına kadar gizlenir.
  private async hideIfThresholdReached(tx: EntityManager, listingId: string): Promise<void> {
    const [{ value }]: { value: number }[] = await tx.query(
      `SELECT COALESCE((SELECT (value #>> '{}')::int FROM settings WHERE key = 'report_hide_threshold'), 3) AS value`,
    );
    const [[hidden]]: [{ reporters: number }[], number] = await tx.query(
      `UPDATE listings SET hidden_by_reports = true, updated_at = now()
       WHERE id = $1 AND NOT hidden_by_reports
         AND (SELECT count(DISTINCT reporter_id) FROM reports WHERE listing_id = $1 AND status = 'open') >= $2
       RETURNING (SELECT count(DISTINCT reporter_id)::int FROM reports WHERE listing_id = $1 AND status = 'open') AS reporters`,
      [listingId, value],
    );
    if (hidden) {
      await audit(tx, {
        actorId: null,
        action: 'listing.auto_hide',
        targetType: 'listing',
        targetId: listingId,
        meta: { reporters: hidden.reporters, threshold: value },
      });
    }
  }
}

const alreadyReported = () => new ApiError(HttpStatus.CONFLICT, 'ALREADY_REPORTED', 'Bunu zaten şikâyet ettiniz.');
