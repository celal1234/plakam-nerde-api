import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { base32Decode, currentStep, hotp } from '../src/admin/totp';
import { REDIS } from '../src/redis/redis.module';
import { createApp, FakeMail, randomPlate, verifiedUser } from './support/app';

const KADIKOY = { lat: 40.9906, lng: 29.0236, source: 'map' as const };

describe('Şikâyet ve yönetim (e2e)', () => {
  let app: INestApplication;
  let mail: FakeMail;
  let db: DataSource;
  let owner: string;
  let reporters: string[];
  let admin: string; // MFA'lı yönetici oturumu
  let adminId: string;
  const bearer = { type: 'bearer' as const };
  const http = () => request(app.getHttpServer());
  const me = async (token: string) => (await http().get('/api/v1/me').auth(token, bearer).expect(200)).body as { id: string; email: string };

  beforeAll(async () => {
    ({ app, mail } = await createApp());
    db = app.get(DataSource);
    owner = await verifiedUser(app, mail, 'sahip');
    reporters = [await verifiedUser(app, mail, 'sikayet1'), await verifiedUser(app, mail, 'sikayet2'), await verifiedUser(app, mail, 'sikayet3')];
    ({ token: admin, id: adminId } = await mfaAdmin('yonetici'));
  });
  afterAll(() => app.close());

  // Yönetici rolü veritabanından verilir (CLI ile aynı); MFA kurulup MFA'lı oturum alınır.
  async function makeAdmin(tag: string) {
    const token = await verifiedUser(app, mail, tag);
    const { id } = await me(token);
    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [id]);
    return { token, id };
  }
  async function mfaAdmin(tag: string) {
    const { token, id } = await makeAdmin(tag);
    const setup = await http().post('/api/v1/admin/mfa/setup').auth(token, bearer).expect(200);
    const res = await http().post('/api/v1/admin/mfa/verify').auth(token, bearer).send({ code: code(setup.body.secret) }).expect(200);
    return { token: res.body.accessToken as string, refresh: res.body.refreshToken as string, id, secret: setup.body.secret as string };
  }
  const code = (secret: string, offset = 0) => hotp(base32Decode(secret), currentStep() + offset);

  async function listing(opts: { token?: string; official?: boolean; plate?: string } = {}): Promise<string> {
    const token = opts.token ?? owner;
    const redis = app.get<Redis>(REDIS);
    const keys = await redis.keys('rl:listing-create:*');
    if (keys.length) await redis.del(...keys);
    const photo = await http().post('/api/v1/photos/upload-url').auth(token, bearer).send({ mime: 'image/jpeg', bytes: 100 }).expect(201);
    const res = await http()
      .post('/api/v1/plates')
      .auth(token, bearer)
      .send({
        plate: opts.plate ?? randomPlate(),
        photoIds: [photo.body.photoId],
        location: KADIKOY,
        city: 'İstanbul',
        foundAt: new Date().toISOString().slice(0, 10),
        isOfficialPlate: opts.official ?? false,
        showPhone: false,
      })
      .expect(201);
    return res.body.id;
  }
  const report = (token: string, body: Record<string, unknown>) => http().post('/api/v1/reports').auth(token, bearer).send(body);

  describe('erişim ve MFA (FR-057)', () => {
    it('yönetici olmayan kullanıcı 403 ADMIN_ONLY alır', async () => {
      const res = await http().get('/api/v1/admin/listings').auth(owner, bearer).expect(403);
      expect(res.body.error.code).toBe('ADMIN_ONLY');
      await http().get('/api/v1/admin/listings').expect(401);
    });

    it('MFA kurulumu, kod doğrulama, tekrar kullanım ve refresh', async () => {
      const { token } = await makeAdmin('mfa');
      expect((await http().get('/api/v1/admin/listings').auth(token, bearer).expect(403)).body.error.code).toBe('ADMIN_MFA_REQUIRED');
      expect((await http().post('/api/v1/admin/mfa/verify').auth(token, bearer).send({ code: '123456' }).expect(409)).body.error.code).toBe(
        'MFA_NOT_SET_UP',
      );

      const setup = await http().post('/api/v1/admin/mfa/setup').auth(token, bearer).expect(200);
      expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/.+secret=[A-Z2-7]+/);
      expect((await http().post('/api/v1/admin/mfa/verify').auth(token, bearer).send({ code: code(setup.body.secret, 5) }).expect(401)).body
        .error.code).toBe('MFA_CODE_INVALID');

      const ok = await http().post('/api/v1/admin/mfa/verify').auth(token, bearer).send({ code: code(setup.body.secret) }).expect(200);
      await http().get('/api/v1/admin/listings').auth(ok.body.accessToken, bearer).expect(200);
      // Aynı kod ikinci kez kabul edilmez; kurulum da tekrarlanamaz.
      await http().post('/api/v1/admin/mfa/verify').auth(token, bearer).send({ code: code(setup.body.secret) }).expect(401);
      expect((await http().post('/api/v1/admin/mfa/setup').auth(token, bearer).expect(409)).body.error.code).toBe('MFA_ALREADY_ENABLED');

      // MFA işareti refresh ile taşınır.
      const refreshed = await http().post('/api/v1/auth/refresh').send({ refreshToken: ok.body.refreshToken }).expect(200);
      await http().get('/api/v1/admin/listings').auth(refreshed.body.accessToken, bearer).expect(200);
      // Sır veritabanında düz metin olarak durmaz.
      const [{ enc }] = await db.query(`SELECT encode(mfa_secret_enc, 'escape') AS enc FROM users WHERE mfa_secret_enc IS NOT NULL LIMIT 1`);
      expect(enc).not.toContain(setup.body.secret);
    });

    it('yetkisi alınan yönetici token süresi dolmadan erişimini kaybeder', async () => {
      const a = await mfaAdmin('eski-yonetici');
      await db.query(`UPDATE users SET role = 'user' WHERE id = $1`, [a.id]);
      await http().get('/api/v1/admin/listings').auth(a.token, bearer).expect(403);
    });
  });

  describe('şikâyet (FR-071, FR-072)', () => {
    it('üç farklı kullanıcının şikâyeti ilanı gizler, "işlem yok" kararı geri açar', async () => {
      const plate = randomPlate();
      const id = await listing({ plate });
      const search = async () => (await http().get('/api/v1/plates/search').query({ q: plate }).expect(200)).body.active.length;

      expect((await report(owner, { listingId: id, reason: 'fake' }).expect(400)).body.error.code).toBe('REPORT_INVALID_TARGET');
      expect((await report(reporters[0], { listingId: id, userId: randomUUID(), reason: 'fake' }).expect(400)).body.error.code).toBe(
        'VALIDATION_FAILED',
      );
      await report(reporters[0], { listingId: id, reason: 'fake' }).expect(201);
      expect((await report(reporters[0], { listingId: id, reason: 'spam' }).expect(409)).body.error.code).toBe('ALREADY_REPORTED');
      await report(reporters[1], { listingId: id, reason: 'wrong_plate', note: 'Plaka farklı' }).expect(201);
      expect(await search()).toBe(1);
      await report(reporters[2], { listingId: id, reason: 'spam' }).expect(201);
      expect(await search()).toBe(0);
      await http().get(`/api/v1/plates/${id}`).expect(404);

      const detail = await http().get(`/api/v1/admin/listings/${id}`).auth(admin, bearer).expect(200);
      expect(detail.body).toMatchObject({ hiddenByReports: true, openReports: 3 });
      expect(detail.body.reports).toHaveLength(3);

      const open = await http().get('/api/v1/admin/reports').auth(admin, bearer).query({ limit: 100 }).expect(200);
      const mine = open.body.items.filter((r: { listing: { id: string } | null }) => r.listing?.id === id);
      expect(mine).toHaveLength(3);
      await http().post(`/api/v1/admin/reports/${mine[0].id}/resolve`).auth(admin, bearer).send({ action: 'none' }).expect(200);
      expect((await http().post(`/api/v1/admin/reports/${mine[0].id}/resolve`).auth(admin, bearer).send({ action: 'none' }).expect(409)).body
        .error.code).toBe('REPORT_ALREADY_RESOLVED');
      expect(await search()).toBe(1);
    });

    it('konuşma şikâyeti karşı tarafı hedefler; kısıtlama kararı mesaj ve ilanı engeller (FR-055)', async () => {
      const finder = await verifiedUser(app, mail, 'bulan');
      const seeker = await verifiedUser(app, mail, 'taciz');
      const id = await listing({ token: finder });
      const conv = await http()
        .post('/api/v1/conversations')
        .auth(seeker, bearer)
        .send({ listingId: id, firstMessage: 'Merhaba', clientId: randomUUID() })
        .expect(201);
      const convId = conv.body.conversation?.id ?? conv.body.id;
      const r = await report(finder, { conversationId: convId, reason: 'harassment' }).expect(201);
      await report(finder, { conversationId: convId, reason: 'harassment' }).expect(409);

      await http().post(`/api/v1/admin/reports/${r.body.id}/resolve`).auth(admin, bearer).send({ action: 'restrict_user', days: 7 }).expect(200);
      const seekerMe = await me(seeker);
      expect(mail.lastTo(seekerMe.email).subject).toBe('Hesabınız kısıtlandı');

      const send = await http()
        .post(`/api/v1/conversations/${convId}/messages`)
        .auth(seeker, bearer)
        .send({ clientId: randomUUID(), kind: 'text', body: 'tekrar' })
        .expect(403);
      expect(send.body.error.code).toBe('USER_RESTRICTED');
      const photo = await http().post('/api/v1/photos/upload-url').auth(seeker, bearer).send({ mime: 'image/jpeg', bytes: 100 }).expect(201);
      const create = await http()
        .post('/api/v1/plates')
        .auth(seeker, bearer)
        .send({ plate: randomPlate(), photoIds: [photo.body.photoId], location: KADIKOY, city: 'İstanbul', foundAt: new Date().toISOString().slice(0, 10), isOfficialPlate: false, showPhone: false })
        .expect(403);
      expect(create.body.error.code).toBe('USER_RESTRICTED');

      await http().post(`/api/v1/admin/users/${seekerMe.id}/unrestrict`).auth(admin, bearer).expect(200);
      await http()
        .post(`/api/v1/conversations/${convId}/messages`)
        .auth(seeker, bearer)
        .send({ clientId: randomUUID(), kind: 'text', body: 'özür dilerim' })
        .expect(201);
    });
  });

  describe('ilan yönetimi (FR-052, FR-073, FR-046)', () => {
    it('resmî plakalı ilanı onaylar veya reddeder', async () => {
      const plate = randomPlate();
      const id = await listing({ official: true, plate });
      const pending = await http().get('/api/v1/admin/listings').auth(admin, bearer).query({ status: 'pending', plate }).expect(200);
      expect(pending.body.items.map((l: { id: string }) => l.id)).toEqual([id]);
      expect(pending.body.items[0].owner).toMatchObject({ displayName: 'sahip' });

      await http().post(`/api/v1/admin/listings/${id}/approve`).auth(admin, bearer).expect(200);
      await http().post(`/api/v1/admin/listings/${id}/approve`).auth(admin, bearer).expect(409);
      expect((await http().get('/api/v1/plates/search').query({ q: plate }).expect(200)).body.active).toHaveLength(1);

      const other = await listing({ official: true });
      await http().post(`/api/v1/admin/listings/${other}/reject`).auth(admin, bearer).send({}).expect(400);
      await http().post(`/api/v1/admin/listings/${other}/reject`).auth(admin, bearer).send({ reason: 'Resmî plaka bilgisi doğrulanamadı.' }).expect(200);
      const { email } = await me(owner);
      expect(mail.lastTo(email).text).toContain('Resmî plaka bilgisi doğrulanamadı.');
    });

    it('kaldırılan ilanın konuşmaları salt okunur olur, sahibine sebep gider', async () => {
      const seeker = await verifiedUser(app, mail, 'arayan');
      const id = await listing();
      const conv = await http()
        .post('/api/v1/conversations')
        .auth(seeker, bearer)
        .send({ listingId: id, firstMessage: 'Plaka benim', clientId: randomUUID() })
        .expect(201);
      const convId = conv.body.conversation?.id ?? conv.body.id;
      await http().post(`/api/v1/admin/listings/${id}/remove`).auth(admin, bearer).send({ reason: 'Mükerrer ilan.' }).expect(200);
      await http().post(`/api/v1/admin/listings/${id}/remove`).auth(admin, bearer).send({ reason: 'tekrar' }).expect(409);
      await http().get(`/api/v1/plates/${id}`).expect(404);
      await http()
        .post(`/api/v1/conversations/${convId}/messages`)
        .auth(seeker, bearer)
        .send({ clientId: randomUUID(), kind: 'text', body: 'merhaba?' })
        .expect(403);
      const { email } = await me(owner);
      expect(mail.lastTo(email)).toMatchObject({ subject: 'İlanınız kaldırıldı' });
      expect(mail.lastTo(email).text).toContain('Mükerrer ilan.');
    });

    it('kesin konum ve telefon görüntüleme denetim kaydına yazılır (FR-056)', async () => {
      const id = await listing();
      const loc = await http().get(`/api/v1/admin/listings/${id}/exact-location`).auth(admin, bearer).expect(200);
      expect(loc.body.lat).toBeCloseTo(KADIKOY.lat, 5);
      const { id: ownerId } = await me(owner);
      expect((await http().get(`/api/v1/admin/users/${ownerId}/phone`).auth(admin, bearer).expect(200)).body).toEqual({ phone: null });

      const rows: { action: string; target_id: string }[] = await db.query(
        `SELECT action, target_id FROM audit_log WHERE actor_id = $1 AND action LIKE 'pii.%' ORDER BY id`,
        [adminId],
      );
      expect(rows.map((r) => `${r.action}:${r.target_id}`)).toEqual(expect.arrayContaining([`pii.location.view:${id}`, `pii.phone.view:${ownerId}`]));
    });
  });

  it('metrikler günlük ilan, arama ve teslim sayılarını verir (FR-074)', async () => {
    const plate = randomPlate();
    await listing({ plate });
    await http().get('/api/v1/plates/search').query({ q: plate }).expect(200);
    await http().get('/api/v1/plates/search').query({ q: randomPlate() }).expect(200);
    const res = await http().get('/api/v1/admin/metrics').auth(admin, bearer).expect(200);
    expect(res.body.days).toHaveLength(30);
    const today = res.body.days.at(-1);
    expect(today.newListings).toBeGreaterThanOrEqual(1);
    expect(today.searches).toBeGreaterThanOrEqual(2);
    expect(today.searchesWithResult).toBeGreaterThanOrEqual(1);
    expect(res.body.totals.matchRate).toBeGreaterThan(0);
  });
});
