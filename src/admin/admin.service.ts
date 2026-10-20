import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../auth/auth.decorators';
import { AuthService, TokenPair } from '../auth/auth.service';
import { audit } from '../common/audit/audit';
import { DataCipher } from '../common/crypto/data-cipher';
import { ApiError } from '../common/errors/api-error';
import { normalizePlate } from '../common/plate/plate';
import { RateLimiter } from '../common/rate-limit/rate-limiter.service';
import { MailMessage, MailService } from '../mail/mail.service';
import { RealtimeService } from '../realtime/realtime.service';
import { REDIS } from '../redis/redis.module';
import { StorageService } from '../storage/storage.service';
import { AdminListingsQueryDto, AdminReportsQueryDto, ResolveReportDto } from './admin.dto';
import { generateSecret, otpauthUrl, TOTP_STEP_SEC, verifyTotp } from './totp';

const EFFECTIVE_STATUS = `CASE WHEN l.status = 'active' AND l.expires_at <= now() THEN 'expired' ELSE l.status::text END`;
const SETUP_TTL_SEC = 600;

const REASON_LABELS: Record<string, string> = {
  fake: 'sahte ilan',
  wrong_plate: 'yanlış plaka',
  inappropriate_photo: 'uygunsuz fotoğraf',
  personal_data: 'kişisel veri',
  harassment: 'taciz',
  spam: 'spam',
  other: 'diğer',
};

interface Actor {
  user: AuthUser;
  ip: string;
}

const listingNotFound = () => new ApiError(HttpStatus.NOT_FOUND, 'LISTING_NOT_FOUND', 'İlan bulunamadı.');
const userNotFound = () => new ApiError(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'Kullanıcı bulunamadı.');
const wrongState = () =>
  new ApiError(HttpStatus.CONFLICT, 'LISTING_NOT_ACTIVE', 'Bu işlem ilanın şu anki durumunda yapılamaz.');

@Injectable()
export class AdminService {
  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly auth: AuthService,
    private readonly cipher: DataCipher,
    private readonly limiter: RateLimiter,
    private readonly mail: MailService,
    private readonly realtime: RealtimeService,
    private readonly storage: StorageService,
  ) {}

  // ---- MFA (FR-057) ----

  async mfaSetup(user: AuthUser) {
    const [row]: { email: string; enabled: boolean }[] = await this.db.query(
      `SELECT email, mfa_secret_enc IS NOT NULL AS enabled FROM users WHERE id = $1`,
      [user.id],
    );
    if (row.enabled) {
      throw new ApiError(HttpStatus.CONFLICT, 'MFA_ALREADY_ENABLED', 'Doğrulama uygulaması zaten kurulu.');
    }
    // Kod doğrulanana kadar sır kalıcı olarak yazılmaz; 10 dakika içinde doğrulanmazsa yeniden kurulum gerekir.
    const secret = generateSecret();
    await this.redis.set(`mfa-setup:${user.id}`, secret, 'EX', SETUP_TTL_SEC);
    return { secret, otpauthUrl: otpauthUrl(secret, row.email), expiresInSec: SETUP_TTL_SEC };
  }

  async mfaVerify(user: AuthUser, code: string, ip: string): Promise<TokenPair> {
    await this.limiter.consume(`mfa:${user.id}`, 5, 300);
    const [row]: { secret: Buffer | null }[] = await this.db.query(`SELECT mfa_secret_enc AS secret FROM users WHERE id = $1`, [
      user.id,
    ]);
    const pending = row.secret ? null : await this.redis.get(`mfa-setup:${user.id}`);
    const secret = row.secret ? this.cipher.decrypt(row.secret) : pending;
    if (!secret) throw new ApiError(HttpStatus.CONFLICT, 'MFA_NOT_SET_UP', 'Önce doğrulama uygulamasını kurun.');

    const step = verifyTotp(secret, code);
    // Aynı kod (veya daha eski bir adım) ikinci kez kullanılamaz.
    const last = Number(await this.redis.get(`mfa-last:${user.id}`)) || 0;
    if (step === null || step <= last) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'MFA_CODE_INVALID', 'Doğrulama kodu hatalı veya süresi geçmiş.');
    }
    await this.redis.set(`mfa-last:${user.id}`, String(step), 'EX', TOTP_STEP_SEC * 4);

    if (pending) {
      await this.db.transaction(async (tx) => {
        await tx.query(`UPDATE users SET mfa_secret_enc = $2 WHERE id = $1`, [user.id, this.cipher.encrypt(pending)]);
        await audit(tx, { actorId: user.id, action: 'admin.mfa.enable', targetType: 'user', targetId: user.id, ip });
      });
      await this.redis.del(`mfa-setup:${user.id}`);
    }
    return this.auth.startMfaSession(user.id);
  }

  // ---- İlanlar (FR-052, FR-073, FR-046) ----

  async listings(q: AdminListingsQueryDto) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.plate) {
      const { normalized } = normalizePlate(q.plate);
      if (normalized) add(`l.plate_normalized LIKE ? || '%'`, normalized);
    }
    if (q.status === 'hidden') where.push('l.hidden_by_reports');
    else if (q.status) add(`${EFFECTIVE_STATUS} = ?`, q.status);
    if (q.city) add(`lower(l.city) = lower(?)`, q.city);
    if (q.from) add(`(l.created_at AT TIME ZONE 'Europe/Istanbul')::date >= ?::date`, q.from);
    if (q.to) add(`(l.created_at AT TIME ZONE 'Europe/Istanbul')::date <= ?::date`, q.to);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows: (AdminListingRow & { total: number })[] = await this.db.query(
      `SELECT ${ADMIN_LISTING_COLUMNS}, count(*) OVER ()::int AS total
       FROM listings l JOIN users u ON u.id = l.owner_id
       ${whereSql}
       ORDER BY l.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, q.offset],
    );
    return {
      total: rows[0]?.total ?? 0,
      items: await Promise.all(rows.map(({ total: _, ...r }) => this.toAdminListing(r))),
    };
  }

  async listingDetail(id: string) {
    const [row]: (AdminListingRow & { photoKeys: string[] })[] = await this.db.query(
      `SELECT ${ADMIN_LISTING_COLUMNS},
              ARRAY(SELECT p.storage_key FROM photos p WHERE p.listing_id = l.id AND p.thumb_key IS NOT NULL ORDER BY p.position) AS "photoKeys"
       FROM listings l JOIN users u ON u.id = l.owner_id WHERE l.id = $1`,
      [id],
    );
    if (!row) throw listingNotFound();
    const reports = await this.db.query(
      `SELECT r.id, r.reason, r.note, r.status, r.created_at AS "createdAt",
              json_build_object('id', ru.id, 'displayName', ru.display_name) AS reporter
       FROM reports r JOIN users ru ON ru.id = r.reporter_id
       WHERE r.listing_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
      [id],
    );
    const { photoKeys, ...rest } = row;
    return {
      ...(await this.toAdminListing(rest)),
      photoUrls: await Promise.all(photoKeys.map((k) => this.storage.presignGet(k))),
      reports,
    };
  }

  async approve(actor: Actor, id: string) {
    const owner = await this.db.transaction(async (tx) => {
      const row = await this.lockListing(tx, id);
      if (row.status !== 'pending') throw wrongState();
      // Süre onay anından başlar; bekleme süresi ilanın ömründen düşmez.
      await tx.query(
        `UPDATE listings SET status = 'active',
           expires_at = now() + make_interval(days => COALESCE((SELECT (value #>> '{}')::int FROM settings WHERE key = 'listing_ttl_days'), 30)),
           version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id],
      );
      await audit(tx, { actorId: actor.user.id, action: 'admin.listing.approve', targetType: 'listing', targetId: id, ip: actor.ip });
      return row;
    });
    await this.notify(owner.email, {
      subject: 'İlanınız yayında',
      text: `${owner.plate_display} plakalı ilanınız incelendi ve yayına alındı.`,
    });
    return { id, status: 'active' };
  }

  async reject(actor: Actor, id: string, reason: string) {
    const owner = await this.db.transaction(async (tx) => {
      const row = await this.lockListing(tx, id);
      if (row.status !== 'pending') throw wrongState();
      await this.markRemoved(tx, id);
      await audit(tx, {
        actorId: actor.user.id,
        action: 'admin.listing.reject',
        targetType: 'listing',
        targetId: id,
        meta: { reason },
        ip: actor.ip,
      });
      return row;
    });
    await this.notify(owner.email, {
      subject: 'İlanınız yayınlanmadı',
      text: `${owner.plate_display} plakalı ilanınız incelendi ve yayınlanmadı.\n\nSebep: ${reason}`,
    });
    return { id, status: 'removed' };
  }

  async remove(actor: Actor, id: string, reason: string) {
    const { row, parties } = await this.db.transaction((tx) => this.removeInTx(tx, actor, id, reason));
    await this.afterRemove(id, row, parties, reason);
    return { id, status: 'removed' };
  }

  // ---- Şikâyetler (FR-053) ----

  async reports(q: AdminReportsQueryDto) {
    const rows: Record<string, unknown>[] = await this.db.query(
      `SELECT r.id, r.reason, r.note, r.status, r.created_at AS "createdAt", r.resolved_at AS "resolvedAt",
              json_build_object('id', ru.id, 'displayName', ru.display_name) AS reporter,
              CASE WHEN l.id IS NULL THEN NULL ELSE json_build_object(
                'id', l.id, 'plateDisplay', l.plate_display, 'status', ${EFFECTIVE_STATUS},
                'hiddenByReports', l.hidden_by_reports,
                'openReports', (SELECT count(DISTINCT r2.reporter_id)::int FROM reports r2 WHERE r2.listing_id = l.id AND r2.status = 'open')) END AS listing,
              CASE WHEN tu.id IS NULL THEN NULL ELSE json_build_object(
                'id', tu.id, 'displayName', tu.display_name, 'status', tu.status, 'restrictedUntil', tu.restricted_until) END AS "targetUser",
              r.conversation_id AS "conversationId",
              count(*) OVER ()::int AS total
       FROM reports r
       JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN listings l ON l.id = r.listing_id
       LEFT JOIN users tu ON tu.id = r.target_user_id
       WHERE r.status = $1
       ORDER BY r.created_at ${q.status === 'open' ? 'ASC' : 'DESC'}
       LIMIT $2 OFFSET $3`,
      [q.status, q.limit, q.offset],
    );
    return { total: (rows[0]?.total as number) ?? 0, items: rows.map(({ total: _, ...r }) => r) };
  }

  async resolveReport(actor: Actor, id: string, dto: ResolveReportDto) {
    let removed: Awaited<ReturnType<AdminService['removeInTx']>> | undefined;
    let removedReason = '';
    let restricted: { email: string | null; until: Date | null } | undefined;

    const result = await this.db.transaction(async (tx) => {
      const [report]: { id: string; status: string; listing_id: string | null; target_user_id: string | null; reason: string }[] =
        await tx.query(`SELECT id, status, listing_id, target_user_id, reason FROM reports WHERE id = $1 FOR UPDATE`, [id]);
      if (!report) throw new ApiError(HttpStatus.NOT_FOUND, 'REPORT_NOT_FOUND', 'Şikâyet bulunamadı.');
      if (report.status !== 'open') {
        throw new ApiError(HttpStatus.CONFLICT, 'REPORT_ALREADY_RESOLVED', 'Bu şikâyet zaten sonuçlandırılmış.');
      }

      if (dto.action === 'none') {
        await tx.query(
          `UPDATE reports SET status = 'resolved_no_action', resolved_by = $2, resolved_at = now() WHERE id = $1`,
          [id, actor.user.id],
        );
        // İlan için açık şikâyet eşiğin altına indiyse otomatik gizleme kalkar.
        if (report.listing_id) await this.unhideIfBelowThreshold(tx, report.listing_id);
      } else if (dto.action === 'remove_listing') {
        if (!report.listing_id) {
          throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Bu şikâyet bir ilana ait değil.', {
            fields: { action: ['no_listing'] },
          });
        }
        // İlanın diğer açık şikâyetleri de removeInTx içinde kapanır.
        removedReason = `Şikâyet: ${REASON_LABELS[report.reason]}${dto.note ? ` (${dto.note})` : ''}`;
        removed = await this.removeInTx(tx, actor, report.listing_id, removedReason, id);
      } else {
        const target = report.target_user_id ?? (await this.listingOwner(tx, report.listing_id));
        if (!target) throw userNotFound();
        restricted = await this.restrictInTx(tx, actor, target, dto.days ?? null, dto.note);
        await tx.query(`UPDATE reports SET status = 'resolved_action', resolved_by = $2, resolved_at = now() WHERE id = $1`, [
          id,
          actor.user.id,
        ]);
      }
      await audit(tx, {
        actorId: actor.user.id,
        action: 'admin.report.resolve',
        targetType: 'report',
        targetId: id,
        meta: { action: dto.action, days: dto.days ?? null, note: dto.note ?? null },
        ip: actor.ip,
      });
      return { id, status: dto.action === 'none' ? 'resolved_no_action' : 'resolved_action' };
    });

    if (removed) await this.afterRemove(removed.row.id, removed.row, removed.parties, removedReason);
    if (restricted) await this.notifyRestricted(restricted);
    return result;
  }

  // ---- Kullanıcılar (FR-055) ----

  async restrict(actor: Actor, userId: string, days: number | null, note?: string) {
    const r = await this.db.transaction((tx) => this.restrictInTx(tx, actor, userId, days, note));
    await this.notifyRestricted(r);
    return { id: userId, status: 'restricted', restrictedUntil: r.until };
  }

  async unrestrict(actor: Actor, userId: string) {
    await this.db.transaction(async (tx) => {
      const [[row]]: [{ id: string }[], number] = await tx.query(
        `UPDATE users SET status = 'active', restricted_until = NULL
         WHERE id = $1 AND status = 'restricted' RETURNING id`,
        [userId],
      );
      if (!row) throw new ApiError(HttpStatus.CONFLICT, 'USER_NOT_RESTRICTED', 'Kullanıcı kısıtlı değil.');
      await audit(tx, { actorId: actor.user.id, action: 'admin.user.unrestrict', targetType: 'user', targetId: userId, ip: actor.ip });
    });
    return { id: userId, status: 'active', restrictedUntil: null };
  }

  // ---- Kişisel veri görüntüleme (FR-056): her çağrı denetim kaydına yazılır ----

  async exactLocation(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const [row]: { lat: number; lng: number }[] = await tx.query(
        `SELECT ST_Y(exact_point::geometry) AS lat, ST_X(exact_point::geometry) AS lng
         FROM listing_private_location WHERE listing_id = $1`,
        [id],
      );
      if (!row) throw listingNotFound();
      await audit(tx, { actorId: actor.user.id, action: 'pii.location.view', targetType: 'listing', targetId: id, ip: actor.ip });
      return { lat: Number(row.lat), lng: Number(row.lng) };
    });
  }

  async phone(actor: Actor, userId: string) {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
      if (!user) throw userNotFound();
      const [row]: { phone_enc: Buffer | null }[] = await tx.query(`SELECT phone_enc FROM user_private WHERE user_id = $1`, [
        userId,
      ]);
      await audit(tx, { actorId: actor.user.id, action: 'pii.phone.view', targetType: 'user', targetId: userId, ip: actor.ip });
      return { phone: row?.phone_enc ? this.cipher.decrypt(row.phone_enc) : null };
    });
  }

  // ---- Metrikler (FR-074) ----

  async metrics(from?: string, to?: string) {
    const days: MetricDay[] = await this.db.query(
      `WITH bounds AS (
         SELECT COALESCE($2::date, (now() AT TIME ZONE 'Europe/Istanbul')::date) AS hi,
                COALESCE($1::date, COALESCE($2::date, (now() AT TIME ZONE 'Europe/Istanbul')::date) - 29) AS lo
       ), days AS (
         SELECT d::date AS day FROM bounds, generate_series(lo, hi, interval '1 day') d
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
         (SELECT count(*)::int FROM listings l WHERE (l.created_at AT TIME ZONE 'Europe/Istanbul')::date = days.day) AS "newListings",
         COALESCE((SELECT value::int FROM metric_daily m WHERE m.day = days.day AND m.key = 'search'), 0) AS searches,
         COALESCE((SELECT value::int FROM metric_daily m WHERE m.day = days.day AND m.key = 'search_hit'), 0) AS "searchesWithResult",
         (SELECT count(*)::int FROM listings l WHERE (l.handed_over_at AT TIME ZONE 'Europe/Istanbul')::date = days.day) AS handovers
       FROM days ORDER BY days.day`,
      [from ?? null, to ?? null],
    );
    if (days.length > 366) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'En fazla 366 günlük aralık seçilebilir.', {
        fields: { from: ['range_too_large'] },
      });
    }
    const sum = (k: keyof Omit<MetricDay, 'day'>) => days.reduce((a, d) => a + d[k], 0);
    const searches = sum('searches');
    const hits = sum('searchesWithResult');
    return {
      from: days[0]?.day ?? null,
      to: days[days.length - 1]?.day ?? null,
      totals: {
        newListings: sum('newListings'),
        searches,
        searchesWithResult: hits,
        matchRate: searches ? Math.round((hits / searches) * 1000) / 1000 : null,
        handovers: sum('handovers'),
      },
      days: days.map((d) => ({
        ...d,
        matchRate: d.searches ? Math.round((d.searchesWithResult / d.searches) * 1000) / 1000 : null,
      })),
    };
  }

  // ---- yardımcılar ----

  private async lockListing(tx: EntityManager, id: string): Promise<LockedListing> {
    const [row]: LockedListing[] = await tx.query(
      `SELECT l.id, l.status::text AS status, l.plate_display, l.owner_id, u.email
       FROM listings l JOIN users u ON u.id = l.owner_id WHERE l.id = $1 FOR UPDATE OF l`,
      [id],
    );
    if (!row) throw listingNotFound();
    return row;
  }

  private async markRemoved(tx: EntityManager, id: string): Promise<void> {
    await tx.query(`UPDATE listings SET status = 'removed', version = version + 1, updated_at = now() WHERE id = $1`, [id]);
    await tx.query(`UPDATE listing_private_location SET purge_after = now() + interval '90 days' WHERE listing_id = $1`, [id]);
  }

  private async removeInTx(tx: EntityManager, actor: Actor, id: string, reason: string, reportId?: string) {
    const row = await this.lockListing(tx, id);
    if (row.status === 'removed') throw wrongState();
    await this.markRemoved(tx, id);
    // Kaldırılan ilanın konuşmaları salt okunur olur; açık şikâyetler işlem yapılmış sayılır.
    const [convs]: [{ id: string; owner_id: string; seeker_id: string }[], number] = await tx.query(
      `UPDATE conversations SET read_only = true WHERE listing_id = $1 AND NOT read_only RETURNING id, owner_id, seeker_id`,
      [id],
    );
    await tx.query(
      `UPDATE reports SET status = 'resolved_action', resolved_by = $2, resolved_at = now() WHERE listing_id = $1 AND status = 'open'`,
      [id, actor.user.id],
    );
    await audit(tx, {
      actorId: actor.user.id,
      action: 'admin.listing.remove',
      targetType: 'listing',
      targetId: id,
      meta: { reason, reportId: reportId ?? null },
      ip: actor.ip,
    });
    return { row, parties: convs };
  }

  private async afterRemove(
    id: string,
    row: LockedListing,
    parties: { id: string; owner_id: string; seeker_id: string }[],
    reason: string,
  ): Promise<void> {
    for (const c of parties) {
      await this.realtime.publish([c.owner_id, c.seeker_id], { type: 'conversation.readonly', conversationId: c.id });
    }
    await this.realtime.publish([row.owner_id], { type: 'listing.status', listingId: id, status: 'removed' });
    await this.notify(row.email, {
      subject: 'İlanınız kaldırıldı',
      text: `${row.plate_display} plakalı ilanınız yönetici tarafından kaldırıldı.\n\nSebep: ${reason}\n\nBir yanlışlık olduğunu düşünüyorsanız bu e-postayı yanıtlayabilirsiniz.`,
    });
  }

  private async unhideIfBelowThreshold(tx: EntityManager, listingId: string): Promise<void> {
    await tx.query(
      `UPDATE listings SET hidden_by_reports = false, updated_at = now()
       WHERE id = $1 AND hidden_by_reports
         AND (SELECT count(DISTINCT reporter_id) FROM reports WHERE listing_id = $1 AND status = 'open')
             < COALESCE((SELECT (value #>> '{}')::int FROM settings WHERE key = 'report_hide_threshold'), 3)`,
      [listingId],
    );
  }

  private async listingOwner(tx: EntityManager, listingId: string | null): Promise<string | null> {
    if (!listingId) return null;
    const [row]: { owner_id: string }[] = await tx.query(`SELECT owner_id FROM listings WHERE id = $1`, [listingId]);
    return row?.owner_id ?? null;
  }

  private async restrictInTx(tx: EntityManager, actor: Actor, userId: string, days: number | null, note?: string) {
    if (userId === actor.user.id) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Kendinizi kısıtlayamazsınız.', { fields: { id: ['self'] } });
    }
    const [[row]]: [{ email: string | null; until: Date | null; role: string }[], number] = await tx.query(
      `UPDATE users SET status = 'restricted',
         restricted_until = CASE WHEN $2::int IS NULL THEN NULL ELSE now() + make_interval(days => $2::int) END
       WHERE id = $1 AND deleted_at IS NULL AND status <> 'banned' AND role <> 'admin'
       RETURNING email, restricted_until AS until, role`,
      [userId, days],
    );
    if (!row) throw userNotFound();
    await audit(tx, {
      actorId: actor.user.id,
      action: 'admin.user.restrict',
      targetType: 'user',
      targetId: userId,
      meta: { days, note: note ?? null },
      ip: actor.ip,
    });
    return { email: row.email, until: row.until };
  }

  private async notifyRestricted(r: { email: string | null; until: Date | null }): Promise<void> {
    const until = r.until
      ? `${r.until.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'long', timeStyle: 'short' })} tarihine kadar`
      : 'süresiz olarak';
    await this.notify(r.email, {
      subject: 'Hesabınız kısıtlandı',
      text: `Kullanım koşullarına aykırı davranış nedeniyle hesabınız ${until} kısıtlandı. Bu sürede ilan veremez ve mesaj gönderemezsiniz; aramaya devam edebilirsiniz.`,
    });
  }

  private async notify(email: string | null, m: Omit<MailMessage, 'to'>): Promise<void> {
    // Hesabını silen kullanıcının e-postası yoktur; bildirim atlanır.
    if (email) await this.mail.send({ to: email, ...m });
  }

  private async toAdminListing(r: AdminListingRow) {
    const { thumbKey, ownerId, ownerDisplayName, ownerStatus, lat, lng, ...rest } = r;
    return {
      ...rest,
      approxCenter: { lat: Number(lat), lng: Number(lng) },
      owner: { id: ownerId, displayName: ownerDisplayName, status: ownerStatus },
      thumbUrl: thumbKey ? await this.storage.presignGet(thumbKey) : null,
    };
  }
}

const ADMIN_LISTING_COLUMNS = `
  l.id, l.plate_display AS "plateDisplay", l.plate_normalized AS "plateNormalized", ${EFFECTIVE_STATUS} AS status,
  l.hidden_by_reports AS "hiddenByReports", l.is_official_plate AS "isOfficialPlate", l.plate_format_ok AS "plateFormatOk",
  l.city, l.district, to_char(l.found_at, 'YYYY-MM-DD') AS "foundAt", l.created_at AS "createdAt", l.expires_at AS "expiresAt",
  l.handover_confirmed AS "handoverConfirmed",
  ST_Y(l.public_point::geometry) AS lat, ST_X(l.public_point::geometry) AS lng,
  u.id AS "ownerId", u.display_name AS "ownerDisplayName", u.status AS "ownerStatus",
  (SELECT count(DISTINCT r.reporter_id)::int FROM reports r WHERE r.listing_id = l.id AND r.status = 'open') AS "openReports",
  (SELECT p.thumb_key FROM photos p WHERE p.listing_id = l.id ORDER BY p.position LIMIT 1) AS "thumbKey"`;

interface AdminListingRow {
  id: string;
  thumbKey: string | null;
  ownerId: string;
  ownerDisplayName: string;
  ownerStatus: string;
  lat: number;
  lng: number;
  [k: string]: unknown;
}

interface LockedListing {
  id: string;
  status: string;
  plate_display: string;
  owner_id: string;
  email: string | null;
}

interface MetricDay {
  day: string;
  newListings: number;
  searches: number;
  searchesWithResult: number;
  handovers: number;
}
