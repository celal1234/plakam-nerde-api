import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createApp, FakeMail, randomPlate, verifiedUser } from './support/app';

const KADIKOY = { lat: 40.9906, lng: 29.0236, source: 'gps' as const };

// GPS konumu gömülü, 1200x900 bir JPEG (telefon kamerası çıktısına benzer).
async function jpegWithGps(): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'TestPhone', Model: 'X1' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 59/1 2616/100', GPSLongitudeRef: 'E', GPSLongitude: '29/1 1/1 2496/100' },
    })
    .toBuffer();
}

describe('Fotoğraf işleme (e2e)', () => {
  let app: INestApplication;
  let mail: FakeMail;
  let db: DataSource;
  let token: string;
  const http = () => request(app.getHttpServer());
  const bearer = { type: 'bearer' as const };

  beforeAll(async () => {
    ({ app, mail } = await createApp());
    db = app.get(DataSource);
    token = await verifiedUser(app, mail, 'foto');
  });
  afterAll(() => app.close());

  async function upload(body: Buffer, mime = 'image/jpeg'): Promise<string> {
    const res = await http().post('/api/v1/photos/upload-url').auth(token, bearer).send({ mime, bytes: body.length }).expect(201);
    const put = await fetch(res.body.putUrl, { method: 'PUT', body: new Uint8Array(body), headers: { 'Content-Type': mime } });
    expect(put.status).toBe(200);
    return res.body.photoId;
  }

  async function publish(photoIds: string[]) {
    const res = await http()
      .post('/api/v1/plates')
      .auth(token, bearer)
      .send({ plate: randomPlate(), photoIds, location: KADIKOY, city: 'İstanbul', foundAt: new Date().toISOString().slice(0, 10), isOfficialPlate: false, showPhone: false })
      .expect(201);
    return res.body.id as string;
  }

  async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const v = await fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('timeout');
  }

  it('yüklenen fotoğrafın konum bilgisi silinir, küçük resim üretilir (AC-19)', async () => {
    const original = await jpegWithGps();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const photoId = await upload(original);
    const listingId = await publish([photoId]);

    await waitFor(async () => {
      const [p] = await db.query(`SELECT thumb_key FROM photos WHERE id = $1`, [photoId]);
      return p?.thumb_key ?? undefined;
    });

    const detail = await http().get(`/api/v1/plates/${listingId}`).expect(200);
    expect(detail.body.thumbUrl).toBeTruthy();
    expect(detail.body.photoUrls).toHaveLength(1);

    for (const url of [detail.body.photoUrls[0], detail.body.thumbUrl]) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
    }

    // Orijinal (konum bilgili) dosya depolamadan silinir.
    const search = await http().get('/api/v1/plates/search').query({ q: detail.body.plateDisplay }).expect(200);
    expect(search.body.active[0].thumbUrl).toBeTruthy();
    const [row] = await db.query(`SELECT storage_key FROM photos WHERE id = $1`, [photoId]);
    expect(row.storage_key).toBe(`photos/${photoId}.jpg`);
  });

  it('resim olmayan dosya reddedilir ve silinir', async () => {
    const good = await upload(await jpegWithGps());
    const fake = await upload(Buffer.from('bu bir resim degil, sadece metin'));
    const listingId = await publish([good, fake]);

    await waitFor(async () => {
      const [p] = await db.query(`SELECT 1 FROM photos WHERE id = $1`, [fake]);
      return p ? undefined : true;
    });
    const [log] = await db.query(`SELECT meta FROM audit_log WHERE action = 'photo.rejected' AND target_id = $1`, [fake]);
    expect(log.meta.reason).toContain('unsupported');

    const detail = await waitFor(async () => {
      const res = await http().get(`/api/v1/plates/${listingId}`);
      return res.body.photoUrls?.length === 1 ? res.body : undefined;
    });
    expect(detail.photoUrls).toHaveLength(1);
  });

  it('HEIC yükleme adresi verilmez', async () => {
    const res = await http().post('/api/v1/photos/upload-url').auth(token, bearer).send({ mime: 'image/heic', bytes: 1000 }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
