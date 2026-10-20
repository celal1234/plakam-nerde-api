import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { AlertsService } from '../alerts/alerts.service';
import { AuthUser } from '../auth/auth.decorators';
import { ApiError } from '../common/errors/api-error';
import { normalizePlate } from '../common/plate/plate';
import { DataCipher } from '../common/crypto/data-cipher';
import { RateLimiter } from '../common/rate-limit/rate-limiter.service';
import { assertCanWrite } from '../common/restriction';
import { PHOTOS, PhotoJob } from '../queue/queue.module';
import { RealtimeService } from '../realtime/realtime.service';
import { StorageService } from '../storage/storage.service';
import {
  CheckDuplicateDto,
  CreatedListing,
  CreateListingDto,
  DuplicateCheck,
  ExtendedListing,
  HandoverConfirmation,
  ListingCard,
  ListingDetail,
  ListingStatus,
  ListingStatusChange,
  ListingVersion,
  LocationDto,
  OwnListing,
  PhoneNumber,
  SearchResult,
  UpdateListingDto,
} from './listings.dto';

// Türkiye'yi kaba bir dikdörtgenle sınırlar (BR-003). Sınır komşularının küçük kısımlarını da
// kapsar; kesin sınır poligonu ileride eklenebilir.
const TR_BOUNDS = { minLat: 35.8, maxLat: 42.2, minLng: 25.6, maxLng: 44.9 };

// İlan süresi geçmiş ama `expire-listings` işi henüz çalışmamışsa da süresi dolmuş sayılır.
const EFFECTIVE_STATUS = `CASE WHEN l.status = 'active' AND l.expires_at <= now() THEN 'expired' ELSE l.status::text END`;

// Herkese açık kart: kesin konum asla seçilmez (AC-14).
const CARD_COLUMNS = `
  l.id, l.plate_display AS "plateDisplay", ${EFFECTIVE_STATUS} AS status,
  to_char(l.found_at, 'YYYY-MM-DD') AS "foundAt", l.city, l.district,
  ST_Y(l.public_point::geometry) AS lat, ST_X(l.public_point::geometry) AS lng,
  l.public_radius_m AS "approxRadiusM",
  (SELECT p.thumb_key FROM photos p WHERE p.listing_id = l.id ORDER BY p.position LIMIT 1) AS "thumbKey"`;

interface CardRow {
  id: string;
  plateDisplay: string;
  status: ListingStatus;
  foundAt: string;
  city: string;
  district: string | null;
  lat: number;
  lng: number;
  approxRadiusM: number;
  thumbKey: string | null;
}

interface DetailRow extends CardRow {
  expiresAt: Date;
  createdAt: Date;
  isOfficialPlate: boolean;
  plateFormatOk: boolean;
  handoverConfirmed: boolean | null;
  extended: boolean;
  version: number;
  ownerDisplayName: string;
  photoKeys: string[];
  hasPhone: boolean;
}

interface OwnedRow {
  id: string;
  owner_id: string;
  status: string;
  effective: string;
  expires_at: Date;
  extended_at: Date | null;
  version: number;
}

const ACTIVE_LIKE = ['active', 'expired'];

@Injectable()
export class ListingsService {
  constructor(
    private readonly db: DataSource,
    private readonly limiter: RateLimiter,
    private readonly storage: StorageService,
    @Inject(PHOTOS) private readonly photoQueue: Queue<PhotoJob>,
    private readonly realtime: RealtimeService,
    private readonly cipher: DataCipher,
    private readonly alerts: AlertsService,
  ) {}

  async search(q: string, ip: string): Promise<SearchResult> {
    await this.limiter.consume(`search:${ip}`, 20, 60);
    const { normalized } = normalizePlate(q);
    if (!normalized) throw new ApiError(HttpStatus.BAD_REQUEST, 'PLATE_REQUIRED', 'Plaka numarası girin.');

    const rows: CardRow[] = await this.db.query(
      `SELECT ${CARD_COLUMNS} FROM listings l
       WHERE l.plate_normalized = $1 AND l.status NOT IN ('pending', 'removed') AND NOT l.hidden_by_reports
       ORDER BY (${EFFECTIVE_STATUS} = 'active') DESC, l.found_at DESC, l.created_at DESC
       LIMIT 50`,
      [normalized],
    );
    await this.countSearch(rows.length > 0);
    const cards = await Promise.all(rows.map((r) => this.toCard(r)));
    return {
      query: { normalized },
      active: cards.filter((c) => c.status === 'active'),
      inactive: cards.filter((c) => c.status !== 'active'),
    };
  }

  async detail(id: string): Promise<ListingDetail> {
    const row = await this.detailRow(id, true);
    if (!row) throw this.notFound();
    return this.toDetail(row);
  }

  async mine(user: AuthUser): Promise<OwnListing[]> {
    const rows: (CardRow & { expiresAt: Date; extended: boolean; version: number })[] = await this.db.query(
      `SELECT ${CARD_COLUMNS}, l.expires_at AS "expiresAt", l.extended_at IS NOT NULL AS extended, l.version
       FROM listings l WHERE l.owner_id = $1 AND l.status <> 'removed'
       ORDER BY l.created_at DESC LIMIT 100`,
      [user.id],
    );
    return Promise.all(
      rows.map(async (r) => ({ ...(await this.toCard(r)), expiresAt: r.expiresAt, extended: r.extended, version: r.version })),
    );
  }

  async checkDuplicate(dto: CheckDuplicateDto): Promise<DuplicateCheck> {
    this.assertInTurkey(dto.location);
    const rows = await this.findDuplicates(this.db.manager, normalizePlate(dto.plate).normalized, dto.location);
    return { duplicates: await Promise.all(rows.map((r) => this.toCard(r))) };
  }

  async create(user: AuthUser, dto: CreateListingDto): Promise<CreatedListing> {
    const plate = normalizePlate(dto.plate);
    if (!plate.normalized) throw new ApiError(HttpStatus.BAD_REQUEST, 'PLATE_REQUIRED', 'Plaka numarası girin.');
    this.assertInTurkey(dto.location);
    await this.assertNotFuture(dto.foundAt);
    await assertCanWrite(this.db, user.id);
    await this.limiter.consume(`listing-create:${user.id}`, 10, 86400);

    const { id, duplicates } = await this.db.transaction(async (tx) => {
      const photos: { id: string }[] = await tx.query(
        `SELECT id FROM photos WHERE id = ANY($1::uuid[]) AND uploader_id = $2 AND listing_id IS NULL FOR UPDATE`,
        [dto.photoIds, user.id],
      );
      if (photos.length !== dto.photoIds.length) {
        throw new ApiError(HttpStatus.BAD_REQUEST, 'PHOTO_REQUIRED', 'Fotoğraflar bulunamadı, lütfen yeniden yükleyin.');
      }

      const duplicates = await this.findDuplicates(tx, plate.normalized, dto.location);
      const ttlDays = await this.setting(tx, 'listing_ttl_days', 30);

      // FR-065: yaklaşık konum kesin noktadan 200–500 m uzakta, rastgele yönde bir kez üretilir.
      const [{ id }]: { id: string }[] = await tx.query(
        `INSERT INTO listings (owner_id, plate_normalized, plate_display, plate_format_ok, is_official_plate, status,
                               found_at, public_point, city, district, show_phone, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 ST_Project(ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography, 200 + random() * 300, radians(random() * 360)),
                 $10, $11, $12, now() + make_interval(days => $13))
         RETURNING id`,
        [
          user.id,
          plate.normalized,
          dto.plate,
          plate.formatOk,
          dto.isOfficialPlate,
          // FR-059: resmî/askerî görünümlü plaka yönetici onayına düşer.
          dto.isOfficialPlate ? 'pending' : 'active',
          dto.foundAt,
          dto.location.lng,
          dto.location.lat,
          dto.city,
          dto.district ?? null,
          dto.showPhone,
          ttlDays,
        ],
      );
      await tx.query(
        `INSERT INTO listing_private_location (listing_id, exact_point)
         VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography)`,
        [id, dto.location.lng, dto.location.lat],
      );
      await tx.query(
        `UPDATE photos p SET listing_id = $1, position = o.pos
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(photo_id, pos) WHERE p.id = o.photo_id`,
        [id, dto.photoIds],
      );
      return { id, duplicates };
    });

    // İşleme ilan yayınlandıktan sonra başlar; jobId fotoğraf kimliği olduğu için aynı fotoğraf iki kez kuyruğa girmez.
    await this.photoQueue.addBulk(dto.photoIds.map((photoId) => ({ name: 'process', data: { photoId }, opts: { jobId: photoId } })));

    // Onay bekleyen (resmî plaka) ilanda alarm, yönetici onayladığında tetiklenir.
    if (!dto.isOfficialPlate) await this.alerts.listingPublished(id);

    const warnings: CreatedListing['warnings'] = [];
    if (!plate.formatOk) warnings.push('PLATE_FORMAT');
    if (duplicates.length) warnings.push('DUPLICATE_NEARBY');
    // Yeni ilan `pending` olabilir; sahibine yine de gösterilir.
    const row = (await this.detailRow(id, false))!;
    return {
      ...(await this.toDetail(row)),
      warnings,
      duplicates: await Promise.all(duplicates.map((d) => this.toCard(d))),
    };
  }

  async update(user: AuthUser, id: string, ifMatch: string | undefined, dto: UpdateListingDto): Promise<ListingVersion> {
    const version = Number(ifMatch?.replace(/"/g, ''));
    if (!Number.isInteger(version)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'If-Match başlığında ilan sürümü gerekli.', {
        fields: { 'If-Match': ['required'] },
      });
    }
    if (dto.foundAt) await this.assertNotFuture(dto.foundAt);

    return this.db.transaction(async (tx) => {
      const row = await this.lockOwned(tx, user, id);
      if (row.version !== version) {
        throw new ApiError(HttpStatus.CONFLICT, 'VERSION_CONFLICT', 'İlan başka bir yerden değiştirildi, sayfayı yenileyin.', {
          currentVersion: row.version,
        });
      }
      if (![...ACTIVE_LIKE, 'pending'].includes(row.effective)) throw this.notActive();
      const [[updated]]: [{ version: number }[], number] = await tx.query(
        `UPDATE listings SET
           show_phone = COALESCE($2, show_phone),
           found_at   = COALESCE($3::date, found_at),
           district   = COALESCE($4, district),
           version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING version`,
        [id, dto.showPhone ?? null, dto.foundAt ?? null, dto.district ?? null],
      );
      return { id, version: updated.version };
    });
  }

  // BR-013: tek uzatma, 30 gün; süre dolduktan en geç 30 gün sonrasına kadar.
  async extend(user: AuthUser, id: string): Promise<ExtendedListing> {
    return this.db.transaction(async (tx) => {
      const row = await this.lockOwned(tx, user, id);
      if (!ACTIVE_LIKE.includes(row.effective)) throw this.notActive();
      if (row.extended_at) {
        throw new ApiError(HttpStatus.CONFLICT, 'EXTENSION_ALREADY_USED', 'Bu ilan daha önce uzatıldı.');
      }
      const extensionDays = await this.setting(tx, 'extension_days', 30);
      const windowMs = extensionDays * 86400_000;
      if (Date.now() > row.expires_at.getTime() + windowMs) {
        throw new ApiError(HttpStatus.CONFLICT, 'EXTENSION_WINDOW_PASSED', 'Uzatma süresi geçti.');
      }
      const [[updated]]: [{ expiresAt: Date; version: number }[], number] = await tx.query(
        `UPDATE listings SET status = 'active', extended_at = now(),
           expires_at = GREATEST(expires_at, now()) + make_interval(days => $2),
           version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING expires_at AS "expiresAt", version`,
        [id, extensionDays],
      );
      return { id, status: 'active', ...updated };
    });
  }

  async close(user: AuthUser, id: string, reason: string): Promise<ListingStatusChange> {
    return this.finish(user, id, [...ACTIVE_LIKE, 'pending'], `status = 'closed', closed_reason = $2`, [reason], 'closed');
  }

  async handover(user: AuthUser, id: string, conversationId?: string): Promise<ListingStatusChange> {
    if (conversationId) {
      const [conv] = await this.db.query(`SELECT 1 FROM conversations WHERE id = $1 AND listing_id = $2`, [conversationId, id]);
      if (!conv) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Konuşma bu ilana ait değil.');
    }
    const result = await this.finish(
      user,
      id,
      ['active'],
      `status = 'handed_over', handover_conversation_id = $2, handover_confirmed = NULL, handed_over_at = now()`,
      [conversationId ?? null],
      'handed_over',
    );
    if (conversationId) {
      // FR-069: karşı tarafa konuşma içinde "teslim aldınız mı?" sorusu düşer.
      const [message] = await this.db.query(
        `WITH ins AS (
           INSERT INTO messages (conversation_id, sender_id, kind, body, client_id)
           VALUES ($1, NULL, 'system', $2, gen_random_uuid()) RETURNING *)
         SELECT ins.id::text AS id, ins.conversation_id AS "conversationId", NULL AS "senderId", ins.kind, ins.body,
                NULL AS point, ins.client_id AS "clientId", ins.created_at AS "createdAt", NULL AS "readAt"
         FROM ins`,
        [conversationId, 'İlan sahibi plakayı teslim ettiğini bildirdi. Plakanızı teslim aldınız mı?'],
      );
      await this.db.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
      const [conv]: { owner_id: string; seeker_id: string }[] = await this.db.query(
        `SELECT owner_id, seeker_id FROM conversations WHERE id = $1`,
        [conversationId],
      );
      await this.realtime.publish([conv.owner_id, conv.seeker_id], { type: 'message.new', message });
    }
    return result;
  }

  // FR-038/039: numara yalnızca sahibi "telefonum görünsün" dediyse, aktif ilanda ve giriş yapmış kullanıcıya verilir.
  // Toplu toplamayı zorlaştırmak için kullanıcı başına günde 20 numara; engellenmiş kullanıcıya hiç verilmez.
  async phone(user: AuthUser, id: string): Promise<PhoneNumber> {
    const [row]: { owner_id: string; phone_enc: Buffer | null; blocked: boolean }[] = await this.db.query(
      `SELECT l.owner_id, up.phone_enc,
              EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = l.owner_id AND b.blocked_id = $2)
                                              OR (b.blocker_id = $2 AND b.blocked_id = l.owner_id)) AS blocked
       FROM listings l LEFT JOIN user_private up ON up.user_id = l.owner_id
       WHERE l.id = $1 AND l.show_phone AND ${EFFECTIVE_STATUS} = 'active' AND NOT l.hidden_by_reports`,
      [id, user.id],
    );
    if (!row?.phone_enc || row.blocked) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'PHONE_NOT_AVAILABLE', 'Bu ilan için telefon numarası paylaşılmıyor.');
    }
    if (row.owner_id !== user.id) await this.limiter.consume(`phone-view:${user.id}`, 20, 86400);
    return { phone: this.cipher.decrypt(row.phone_enc) };
  }

  // FR-069: teslim konuşmasının arayan tarafı 7 gün içinde bir kez yanıtlar. "Hayır" yönetici incelemesine düşer.
  async confirmHandover(user: AuthUser, id: string, confirmed: boolean): Promise<HandoverConfirmation> {
    return this.db.transaction(async (tx) => {
      const [row]: { allowed: boolean }[] = await tx.query(
        `SELECT (l.status = 'handed_over' AND l.handover_confirmed IS NULL
                 AND l.handed_over_at > now() - interval '7 days' AND c.seeker_id = $2) AS allowed
         FROM listings l JOIN conversations c ON c.id = l.handover_conversation_id
         WHERE l.id = $1 FOR UPDATE OF l`,
        [id, user.id],
      );
      if (!row?.allowed) {
        throw new ApiError(HttpStatus.CONFLICT, 'HANDOVER_CONFIRM_NOT_ALLOWED', 'Bu ilan için teslim onayı verilemez.');
      }
      await tx.query(
        `UPDATE listings SET handover_confirmed = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, confirmed],
      );
      if (!confirmed) {
        await tx.query(
          `INSERT INTO reports (reporter_id, listing_id, reason, note) VALUES ($1, $2, 'other', $3)
           ON CONFLICT DO NOTHING`,
          [user.id, id, 'Teslim onayı: arayan kişi plakayı teslim almadığını bildirdi (FR-069).'],
        );
      }
      return { id, handoverConfirmed: confirmed };
    });
  }

  private async finish(
    user: AuthUser,
    id: string,
    from: string[],
    set: string,
    params: unknown[],
    to: ListingStatus,
  ): Promise<ListingStatusChange> {
    return this.db.transaction(async (tx) => {
      const row = await this.lockOwned(tx, user, id);
      if (!from.includes(row.effective)) throw this.notActive();
      const [[updated]]: [{ version: number }[], number] = await tx.query(
        `UPDATE listings SET ${set}, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
        [id, ...params],
      );
      // Kesin konum kapanıştan 90 gün sonra silinir (T6 şema notu).
      await tx.query(`UPDATE listing_private_location SET purge_after = now() + interval '90 days' WHERE listing_id = $1`, [id]);
      return { id, status: to, version: updated.version };
    });
  }

  private async detailRow(id: string, publicOnly: boolean): Promise<DetailRow | undefined> {
    const [row]: DetailRow[] = await this.db.query(
      `SELECT ${CARD_COLUMNS},
              l.expires_at AS "expiresAt", l.created_at AS "createdAt", l.is_official_plate AS "isOfficialPlate",
              l.plate_format_ok AS "plateFormatOk", l.handover_confirmed AS "handoverConfirmed",
              l.extended_at IS NOT NULL AS extended, l.version, u.display_name AS "ownerDisplayName",
              ARRAY(SELECT p.storage_key FROM photos p WHERE p.listing_id = l.id AND p.thumb_key IS NOT NULL ORDER BY p.position) AS "photoKeys",
              (l.show_phone AND ${EFFECTIVE_STATUS} = 'active' AND EXISTS (SELECT 1 FROM user_private up WHERE up.user_id = l.owner_id AND up.phone_enc IS NOT NULL)) AS "hasPhone"
       FROM listings l JOIN users u ON u.id = l.owner_id
       WHERE l.id = $1 ${publicOnly ? `AND l.status NOT IN ('pending', 'removed') AND NOT l.hidden_by_reports` : ''}`,
      [id],
    );
    return row;
  }

  private async lockOwned(tx: EntityManager, user: AuthUser, id: string): Promise<OwnedRow> {
    const [row]: OwnedRow[] = await tx.query(
      `SELECT l.id, l.status, ${EFFECTIVE_STATUS} AS effective, l.expires_at, l.extended_at, l.version, l.owner_id
       FROM listings l WHERE l.id = $1 AND l.status <> 'removed' FOR UPDATE`,
      [id],
    );
    if (!row) throw this.notFound();
    if (row.owner_id !== user.id) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'LISTING_NOT_OWNER', 'Bu ilan size ait değil.');
    }
    return row;
  }

  // BR-009: aynı plaka, kesin konuma 2 km içinde, aktif ilan.
  private async findDuplicates(tx: EntityManager, plate: string, loc: LocationDto): Promise<CardRow[]> {
    const radius = await this.setting(tx, 'dup_radius_m', 2000);
    return tx.query(
      `SELECT ${CARD_COLUMNS} FROM listings l
       JOIN listing_private_location pl ON pl.listing_id = l.id
       WHERE l.plate_normalized = $1 AND l.status = 'active' AND l.expires_at > now() AND NOT l.hidden_by_reports
         AND ST_DWithin(pl.exact_point, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
       ORDER BY l.created_at DESC LIMIT 10`,
      [plate, loc.lng, loc.lat, radius],
    );
  }

  // FR-074 panel metrikleri: günlük arama ve sonuç bulunan arama sayısı (İstanbul günü). Sorgu metni saklanmaz.
  private async countSearch(hit: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO metric_daily (day, key, value)
       SELECT (now() AT TIME ZONE 'Europe/Istanbul')::date, k, 1 FROM unnest($1::text[]) AS k
       ON CONFLICT (day, key) DO UPDATE SET value = metric_daily.value + 1`,
      [hit ? ['search', 'search_hit'] : ['search']],
    );
  }

  private async setting(tx: EntityManager, key: string, fallback: number): Promise<number> {
    const [row]: { value: unknown }[] = await tx.query(`SELECT value FROM settings WHERE key = $1`, [key]);
    return typeof row?.value === 'number' ? row.value : fallback;
  }

  private assertInTurkey({ lat, lng }: LocationDto): void {
    if (lat < TR_BOUNDS.minLat || lat > TR_BOUNDS.maxLat || lng < TR_BOUNDS.minLng || lng > TR_BOUNDS.maxLng) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'LOCATION_OUTSIDE_TR', 'Konum Türkiye sınırları içinde olmalı.');
    }
  }

  private async assertNotFuture(foundAt: string): Promise<void> {
    const [{ future }]: { future: boolean }[] = await this.db.query(
      `SELECT $1::date > (now() AT TIME ZONE 'Europe/Istanbul')::date AS future`,
      [foundAt],
    );
    if (future) throw new ApiError(HttpStatus.BAD_REQUEST, 'FOUND_AT_IN_FUTURE', 'Bulunma tarihi ileri bir tarih olamaz.');
  }

  private async toCard(r: CardRow): Promise<ListingCard> {
    return {
      id: r.id,
      plateDisplay: r.plateDisplay,
      status: r.status,
      foundAt: r.foundAt,
      city: r.city,
      district: r.district,
      // Küçük resim fotoğraf işlenince oluşur; o zamana kadar null.
      thumbUrl: r.thumbKey ? await this.storage.presignGet(r.thumbKey) : null,
      approxCenter: { lat: Number(r.lat), lng: Number(r.lng) },
      approxRadiusM: r.approxRadiusM,
    };
  }

  private async toDetail(r: DetailRow): Promise<ListingDetail> {
    return {
      ...(await this.toCard(r)),
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      isOfficialPlate: r.isOfficialPlate,
      plateFormatOk: r.plateFormatOk,
      handoverConfirmed: r.handoverConfirmed,
      extended: r.extended,
      version: r.version,
      owner: { displayName: r.ownerDisplayName },
      // Numaranın kendisi detayda yok; giriş yapmış kullanıcı `GET /plates/{id}/phone` ile ister (FR-039).
      hasPhone: r.hasPhone,
      // Yalnızca işlenmiş (EXIF'i silinmiş) fotoğraflar; işlenmemiş orijinal asla dışarı verilmez.
      photoUrls: await Promise.all(r.photoKeys.map((k) => this.storage.presignGet(k))),
    };
  }

  private notFound() {
    return new ApiError(HttpStatus.NOT_FOUND, 'LISTING_NOT_FOUND', 'İlan bulunamadı.');
  }

  private notActive() {
    return new ApiError(HttpStatus.CONFLICT, 'LISTING_NOT_ACTIVE', 'Bu işlem ilanın şu anki durumunda yapılamaz.');
  }
}
