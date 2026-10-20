import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { REDIS } from '../src/redis/redis.module';
import { createApp, FakeMail, randomPlate, verifiedUser } from './support/app';

const KADIKOY = { lat: 40.9906, lng: 29.0236, source: 'map' as const };

describe('Telefon numarası (e2e)', () => {
  let app: INestApplication;
  let mail: FakeMail;
  let db: DataSource;
  let owner: string;
  let viewer: string;
  const bearer = { type: 'bearer' as const };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, mail } = await createApp());
    db = app.get(DataSource);
    owner = await verifiedUser(app, mail, 'sahip');
    viewer = await verifiedUser(app, mail, 'bakan');
  });
  afterAll(() => app.close());

  async function listing(showPhone: boolean): Promise<string> {
    const redis = app.get<Redis>(REDIS);
    const keys = await redis.keys('rl:listing-create:*');
    if (keys.length) await redis.del(...keys);
    const photo = await http().post('/api/v1/photos/upload-url').auth(owner, bearer).send({ mime: 'image/jpeg', bytes: 100 }).expect(201);
    const res = await http()
      .post('/api/v1/plates')
      .auth(owner, bearer)
      .send({ plate: randomPlate(), photoIds: [photo.body.photoId], location: KADIKOY, city: 'İstanbul', foundAt: new Date().toISOString().slice(0, 10), isOfficialPlate: false, showPhone })
      .expect(201);
    return res.body.id;
  }

  it('numara kaydedilir, yalnız son 4 hane döner ve veritabanında şifreli durur (FR-036, NFR-006)', async () => {
    expect((await http().get('/api/v1/me/phone').auth(owner, bearer).expect(200)).body).toEqual({ last4: null });
    expect((await http().patch('/api/v1/me/phone').auth(owner, bearer).send({ phone: '+49 151 1234567' }).expect(400)).body.error.code).toBe(
      'PHONE_INVALID',
    );
    const res = await http().patch('/api/v1/me/phone').auth(owner, bearer).send({ phone: '0532 123 45 67' }).expect(200);
    expect(res.body).toEqual({ last4: '4567' });
    expect((await http().get('/api/v1/me').auth(owner, bearer).expect(200)).body.phoneLast4).toBe('4567');

    const rows: { raw: string }[] = await db.query(`SELECT encode(phone_enc, 'escape') AS raw FROM user_private WHERE phone_last4 = '4567'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.raw).not.toContain('5321234567');
  });

  it('gösterme izni olmayan ilanda numara hiçbir yanıtta yok (FR-038, FR-039)', async () => {
    const id = await listing(false);
    const detail = await http().get(`/api/v1/plates/${id}`).expect(200);
    expect(detail.body.hasPhone).toBe(false);
    expect(JSON.stringify(detail.body)).not.toContain('5321234567');
    expect((await http().get(`/api/v1/plates/${id}/phone`).auth(viewer, bearer).expect(404)).body.error.code).toBe('PHONE_NOT_AVAILABLE');
  });

  it('izin varsa numara yalnız giriş yapmış kullanıcıya verilir', async () => {
    const id = await listing(true);
    const detail = await http().get(`/api/v1/plates/${id}`).expect(200);
    expect(detail.body.hasPhone).toBe(true);
    expect(JSON.stringify(detail.body)).not.toContain('5321234567');

    await http().get(`/api/v1/plates/${id}/phone`).expect(401);
    expect((await http().get(`/api/v1/plates/${id}/phone`).auth(viewer, bearer).expect(200)).body).toEqual({ phone: '+905321234567' });

    // İlan kapanınca numara artık verilmez.
    await http().post(`/api/v1/plates/${id}/close`).auth(owner, bearer).send({ reason: 'mistake' }).expect(200);
    await http().get(`/api/v1/plates/${id}/phone`).auth(viewer, bearer).expect(404);
  });

  it('numara silinince ilanda da gösterilmez', async () => {
    const id = await listing(true);
    await http().delete('/api/v1/me/phone').auth(owner, bearer).expect(204);
    expect((await http().get('/api/v1/me/phone').auth(owner, bearer).expect(200)).body).toEqual({ last4: null });
    expect((await http().get(`/api/v1/plates/${id}`).expect(200)).body.hasPhone).toBe(false);
    await http().get(`/api/v1/plates/${id}/phone`).auth(viewer, bearer).expect(404);
  });
});
