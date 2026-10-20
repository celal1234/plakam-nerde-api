import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../auth/auth.decorators';
import { ApiError } from '../common/errors/api-error';
import { normalizePlate } from '../common/plate/plate';
import { RateLimiter } from '../common/rate-limit/rate-limiter.service';
import { StorageService } from '../storage/storage.service';
import { CheckDuplicateDto, CreateListingDto, LocationDto, UpdateListingDto } from './listings.dto';

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
  status: string;
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
  photoKeys: (string | null)[];
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
  ) {}

  async search(q: string, ip: string) {
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
    const cards = await Promise.all(rows.map((r) => this.toCard(r)));
    return {
      query: { normalized },
      active: cards.filter((c) => c.status === 'active'),
      inactive: cards.filter((c) => c.status !== 'active'),
    };
  }

  async detail(id: string) {
    const row = await this.detailRow(id, true);
    if (!row) throw this.notFound();
    return this.toDetail(row);
  }

  async mine(user: AuthUser) {
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

  async checkDuplicate(dto: CheckDuplicateDto) {
    this.assertInTurkey(dto.location);
    const rows = await this.findDuplicates(this.db.manager, normalizePlate(dto.plate).normalized, dto.location);
    return { duplicates: await Promise.all(rows.map((r) => this.toCard(r))) };
  }

  async create(user: AuthUser, dto: CreateListingDto) {
    const plate = normalizePlate(dto.plate);
    if (!plate.normalized) throw new ApiError(HttpStatus.BAD_REQUEST, 'PLATE_REQUIRED', 'Plaka numarası girin.');
    this.assertInTurkey(dto.location);
    await this.assertNotFuture(dto.foundAt);
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

    const warnings: string[] = [];
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

  async update(user: AuthUser, id: string, ifMatch: string | undefined, dto: UpdateListingDto) {
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
  async extend(user: AuthUser, id: string) {
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

  async close(user: AuthUser, id: string, reason: string) {
    return this.finish(user, id, [...ACTIVE_LIKE, 'pending'], `status = 'closed', closed_reason = $2`, [reason], 'closed');
  }

  async handover(user: AuthUser, id: string, conversationId?: string) {
    if (conversationId) {
      const [conv] = await this.db.query(`SELECT 1 FROM conversations WHERE id = $1 AND listing_id = $2`, [conversationId, id]);
      if (!conv) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Konuşma bu ilana ait değil.');
    }
    return this.finish(
      user,
      id,
      ['active'],
      `status = 'handed_over', handover_conversation_id = $2, handover_confirmed = NULL`,
      [conversationId ?? null],
      'handed_over',
    );
  }

  private async finish(user: AuthUser, id: string, from: string[], set: string, params: unknown[], to: string) {
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
              ARRAY(SELECT p.thumb_key FROM photos p WHERE p.listing_id = l.id ORDER BY p.position) AS "photoKeys"
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

  private async toCard(r: CardRow) {
    return {
      id: r.id,
      plateDisplay: r.plateDisplay,
      status: r.status,
      foundAt: r.foundAt,
      city: r.city,
      district: r.district,
      // Küçük resimler EXIF temizleme işinden sonra oluşur; o zamana kadar null.
      thumbUrl: r.thumbKey ? await this.storage.presignGet(r.thumbKey) : null,
      approxCenter: { lat: Number(r.lat), lng: Number(r.lng) },
      approxRadiusM: r.approxRadiusM,
    };
  }

  private async toDetail(r: DetailRow) {
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
      photoUrls: await Promise.all(r.photoKeys.filter((k): k is string => !!k).map((k) => this.storage.presignGet(k))),
      photoCount: r.photoKeys.length,
    };
  }

  private notFound() {
    return new ApiError(HttpStatus.NOT_FOUND, 'LISTING_NOT_FOUND', 'İlan bulunamadı.');
  }

  private notActive() {
    return new ApiError(HttpStatus.CONFLICT, 'LISTING_NOT_ACTIVE', 'Bu işlem ilanın şu anki durumunda yapılamaz.');
  }
}
