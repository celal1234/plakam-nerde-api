import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS } from '../src/redis/redis.module';
import { createApp, FakeMail, randomPlate, uniqueEmail, verifiedUser } from './support/app';

// Kadıköy iskelesi civarı.
const KADIKOY = { lat: 40.9906, lng: 29.0236, source: 'map' as const };

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

describe('İlanlar ve arama (e2e)', () => {
  let app: INestApplication;
  let mail: FakeMail;
  let db: DataSource;
  let owner: string;
  let other: string;
  const http = () => request(app.getHttpServer());
  const bearer = { type: 'bearer' as const };
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    ({ app, mail } = await createApp());
    db = app.get(DataSource);
    owner = await verifiedUser(app, mail, 'sahip');
    other = await verifiedUser(app, mail, 'baska');
  });
  afterAll(() => app.close());

  async function clearLimits(pattern: string) {
    const redis = app.get<Redis>(REDIS);
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  }

  async function photo(token: string): Promise<string> {
    const res = await http()
      .post('/api/v1/photos/upload-url')
      .auth(token, bearer)
      .send({ mime: 'image/jpeg', bytes: 1_500_000 })
      .expect(201);
    expect(res.body.putUrl).toContain('X-Amz-Signature=');
    return res.body.photoId;
  }

  async function createListing(token: string, overrides: Record<string, unknown> = {}) {
    // Fotoğraf isteği ana istek kurulmadan önce bitmeli: supertest geçici sunucuyu istek bitince kapatır.
    const photoIds = 'photoIds' in overrides ? overrides.photoIds : [await photo(token)];
    // Testler kullanıcı başına günlük 10 ilan sınırını (BR-016) aşar; sınırın kendisi ayrı testte.
    await clearLimits('rl:listing-create:*');
    return http()
      .post('/api/v1/plates')
      .auth(token, bearer)
      .send({
        plate: randomPlate(),
        photoIds,
        location: KADIKOY,
        city: 'İstanbul',
        district: 'Kadıköy',
        foundAt: today,
        isOfficialPlate: false,
        showPhone: false,
        ...overrides,
      });
  }

  it('e-postası doğrulanmamış kullanıcı ilan veremez', async () => {
    const email = uniqueEmail('dogrulanmamis');
    await http()
      .post('/api/v1/auth/register')
      .send({ email, password: 'cok-gizli-sifre-1', displayName: 'Xx', termsVersion: '2026-10' })
      .expect(201);
    const { body } = await http().post('/api/v1/auth/login').send({ email, password: 'cok-gizli-sifre-1' }).expect(200);
    const res = await http().post('/api/v1/photos/upload-url').auth(body.accessToken, bearer).send({ mime: 'image/jpeg', bytes: 10 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('10 MB üstü ve desteklenmeyen fotoğraf reddedilir', async () => {
    const big = await http().post('/api/v1/photos/upload-url').auth(owner, bearer).send({ mime: 'image/jpeg', bytes: 11 * 1024 * 1024 });
    expect(big.body.error.code).toBe('PHOTO_TOO_LARGE');
    const gif = await http().post('/api/v1/photos/upload-url').auth(owner, bearer).send({ mime: 'image/gif', bytes: 100 });
    expect(gif.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('ilan açılır, üyeliksiz aramada çıkar ve kesin konum hiçbir yanıtta yoktur (AC-13, AC-14)', async () => {
    const plate = randomPlate();
    const created = await createListing(owner, { plate });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'active', plateDisplay: plate, city: 'İstanbul', warnings: [] });

    const offset = metersBetween(KADIKOY, created.body.approxCenter);
    expect(offset).toBeGreaterThanOrEqual(195);
    expect(offset).toBeLessThanOrEqual(505);

    const search = await http().get('/api/v1/plates/search').query({ q: plate.toLowerCase().replace(/ /g, '-') }).expect(200);
    expect(search.body.query.normalized).toBe(plate.replace(/ /g, ''));
    expect(search.body.active.map((c: { id: string }) => c.id)).toEqual([created.body.id]);

    const detail = await http().get(`/api/v1/plates/${created.body.id}`).expect(200);
    expect(detail.body.approxCenter).toEqual(created.body.approxCenter);
    for (const body of [created.body, search.body, detail.body]) {
      const json = JSON.stringify(body);
      expect(json).not.toContain(String(KADIKOY.lat));
      expect(json).not.toContain(String(KADIKOY.lng));
    }
  });

  it('aynı plakaya 2 km içinde ikinci ilan uyarı alır (BR-009)', async () => {
    const plate = randomPlate();
    await createListing(owner, { plate }).then((r) => expect(r.status).toBe(201));

    const near = { ...KADIKOY, lat: KADIKOY.lat + 0.01 }; // ~1,1 km
    const check = await http().post('/api/v1/plates/check-duplicate').auth(other, bearer).send({ plate, location: near }).expect(200);
    expect(check.body.duplicates).toHaveLength(1);

    const second = await createListing(other, { plate, location: near });
    expect(second.body.warnings).toEqual(['DUPLICATE_NEARBY']);

    const far = await http()
      .post('/api/v1/plates/check-duplicate')
      .auth(other, bearer)
      .send({ plate, location: { ...KADIKOY, lat: KADIKOY.lat + 0.05 } })
      .expect(200);
    expect(far.body.duplicates).toHaveLength(0);
  });

  it('format dışı plaka uyarıyla yayınlanır', async () => {
    const res = await createListing(owner, { plate: 'ABC 12' });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toContain('PLATE_FORMAT');
  });

  it('fotoğraf, konum ve tarih kuralları', async () => {
    const used = await photo(owner);
    await createListing(owner, { photoIds: [used] }).then((r) => expect(r.status).toBe(201));
    const reuse = await createListing(owner, { photoIds: [used] });
    expect(reuse.body.error.code).toBe('PHOTO_REQUIRED');

    const foreignPhoto = await photo(other);
    const foreign = await createListing(owner, { photoIds: [foreignPhoto] });
    expect(foreign.body.error.code).toBe('PHOTO_REQUIRED');

    const athens = await createListing(owner, { location: { lat: 37.98, lng: 23.72, source: 'gps' } });
    expect(athens.body.error.code).toBe('LOCATION_OUTSIDE_TR');

    const tomorrow = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    const future = await createListing(owner, { foundAt: tomorrow });
    expect(future.body.error.code).toBe('FOUND_AT_IN_FUTURE');

    const noPhoto = await createListing(owner, { photoIds: [] });
    expect(noPhoto.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('resmî plaka onay bekler: aramada ve detayda görünmez, sahibinin listesinde görünür (FR-059)', async () => {
    const plate = randomPlate();
    const created = await createListing(owner, { plate, isOfficialPlate: true });
    expect(created.body.status).toBe('pending');

    const search = await http().get('/api/v1/plates/search').query({ q: plate }).expect(200);
    expect(search.body.active).toHaveLength(0);
    expect(search.body.inactive).toHaveLength(0);
    await http().get(`/api/v1/plates/${created.body.id}`).expect(404);

    const mine = await http().get('/api/v1/me/listings').auth(owner, bearer).expect(200);
    expect(mine.body.find((l: { id: string }) => l.id === created.body.id)?.status).toBe('pending');
  });

  it('başkasının ilanı değiştirilemez (BR-006), geçersiz kimlik 404 döner', async () => {
    const { body } = await createListing(owner);
    const res = await http().post(`/api/v1/plates/${body.id}/close`).auth(other, bearer).send({ reason: 'mistake' }).expect(403);
    expect(res.body.error.code).toBe('LISTING_NOT_OWNER');
    const bad = await http().get('/api/v1/plates/olmayan-id').expect(404);
    expect(bad.body.error.code).toBe('LISTING_NOT_FOUND');
  });

  it('süresi dolan ilan pasife düşer, bir kez uzatılabilir (AC-15, BR-013)', async () => {
    const plate = randomPlate();
    const { body } = await createListing(owner, { plate });
    await db.query(`UPDATE listings SET expires_at = now() - interval '2 days' WHERE id = $1`, [body.id]);

    const search = await http().get('/api/v1/plates/search').query({ q: plate }).expect(200);
    expect(search.body.inactive.map((c: { status: string }) => c.status)).toEqual(['expired']);

    const ext = await http().post(`/api/v1/plates/${body.id}/extend`).auth(owner, bearer).expect(200);
    expect(ext.body.status).toBe('active');
    const days = (new Date(ext.body.expiresAt).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const again = await http().post(`/api/v1/plates/${body.id}/extend`).auth(owner, bearer).expect(409);
    expect(again.body.error.code).toBe('EXTENSION_ALREADY_USED');
  });

  it('süre dolduktan 30 günden sonra uzatılamaz', async () => {
    const { body } = await createListing(owner);
    await db.query(`UPDATE listings SET expires_at = now() - interval '31 days' WHERE id = $1`, [body.id]);
    const res = await http().post(`/api/v1/plates/${body.id}/extend`).auth(owner, bearer).expect(409);
    expect(res.body.error.code).toBe('EXTENSION_WINDOW_PASSED');
  });

  it('düzenleme sürüm kontrolüyle yapılır (NFR-012)', async () => {
    const { body } = await createListing(owner);
    const ok = await http()
      .patch(`/api/v1/plates/${body.id}`)
      .auth(owner, bearer)
      .set('If-Match', String(body.version))
      .send({ showPhone: true, district: 'Moda' })
      .expect(200);
    expect(ok.body.version).toBe(body.version + 1);

    const stale = await http()
      .patch(`/api/v1/plates/${body.id}`)
      .auth(owner, bearer)
      .set('If-Match', String(body.version))
      .send({ showPhone: false })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await http().get(`/api/v1/plates/${body.id}`)).body.district).toBe('Moda');
  });

  it('kapatılan ve teslim edilen ilanlar pasif listede görünür (BR-010)', async () => {
    const plate = randomPlate();
    const a = (await createListing(owner, { plate })).body;
    const b = (await createListing(other, { plate, location: { ...KADIKOY, lat: 39.92, lng: 32.85 } })).body;

    await http().post(`/api/v1/plates/${a.id}/close`).auth(owner, bearer).send({ reason: 'given_to_police' }).expect(200);
    await http().post(`/api/v1/plates/${b.id}/handover`).auth(other, bearer).send({}).expect(200);

    const search = await http().get('/api/v1/plates/search').query({ q: plate }).expect(200);
    expect(search.body.active).toHaveLength(0);
    expect(search.body.inactive.map((c: { status: string }) => c.status).sort()).toEqual(['closed', 'handed_over']);

    const ext = await http().post(`/api/v1/plates/${a.id}/extend`).auth(owner, bearer).expect(409);
    expect(ext.body.error.code).toBe('LISTING_NOT_ACTIVE');
    const [loc] = await db.query(`SELECT purge_after FROM listing_private_location WHERE listing_id = $1`, [a.id]);
    expect(loc.purge_after).not.toBeNull();
  });

  it('kullanıcı günde en fazla 10 ilan açar (BR-016)', async () => {
    const token = await verifiedUser(app, mail, 'spam');
    const photos: string[] = [];
    for (let i = 0; i < 11; i++) photos.push(await photo(token));
    await clearLimits('rl:listing-create:*');
    const send = (photoId: string) =>
      http()
        .post('/api/v1/plates')
        .auth(token, bearer)
        .send({ plate: randomPlate(), photoIds: [photoId], location: KADIKOY, city: 'İstanbul', foundAt: today, isOfficialPlate: false, showPhone: false });
    for (const p of photos.slice(0, 10)) await send(p).expect(201);
    const res = await send(photos[10]).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('üyeliksiz arama IP başına dakikada 20 ile sınırlı (FR-063)', async () => {
    await clearLimits('rl:search:*');
    for (let i = 0; i < 20; i++) await http().get('/api/v1/plates/search').query({ q: '34ABC123' }).expect(200);
    const res = await http().get('/api/v1/plates/search').query({ q: '34ABC123' }).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});
