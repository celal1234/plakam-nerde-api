import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { MaintenanceService } from '../src/maintenance/maintenance.service';
import { REDIS } from '../src/redis/redis.module';
import { createApp, FakeMail, randomPlate, verifiedUser } from './support/app';

const KADIKOY = { lat: 40.9906, lng: 29.0236, source: 'map' as const };

describe('Zamanlanmış işler ve teslim onayı (e2e)', () => {
  let app: INestApplication;
  let mail: FakeMail;
  let db: DataSource;
  let jobs: MaintenanceService;
  let owner: string;
  let seeker: string;
  const bearer = { type: 'bearer' as const };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, mail } = await createApp());
    db = app.get(DataSource);
    jobs = app.get(MaintenanceService);
    owner = await verifiedUser(app, mail, 'sahip');
    seeker = await verifiedUser(app, mail, 'arayan');
  });
  afterAll(() => app.close());

  const me = async (token: string) => (await http().get('/api/v1/me').auth(token, bearer)).body as { id: string; email: string };

  async function listing(token = owner): Promise<{ id: string; plate: string }> {
    const redis = app.get<Redis>(REDIS);
    const keys = await redis.keys('rl:listing-create:*');
    if (keys.length) await redis.del(...keys);
    const photo = await http().post('/api/v1/photos/upload-url').auth(token, bearer).send({ mime: 'image/jpeg', bytes: 100 }).expect(201);
    const plate = randomPlate();
    const res = await http()
      .post('/api/v1/plates')
      .auth(token, bearer)
      .send({ plate, photoIds: [photo.body.photoId], location: KADIKOY, city: 'İstanbul', foundAt: new Date().toISOString().slice(0, 10), isOfficialPlate: false, showPhone: false })
      .expect(201);
    return { id: res.body.id, plate };
  }

  const status = async (id: string) => (await db.query(`SELECT status FROM listings WHERE id = $1`, [id]))[0].status;

  it('süresi dolan ilan expired olur ve kesin konumu silinmek üzere işaretlenir (AC-15)', async () => {
    const { id } = await listing();
    await db.query(`UPDATE listings SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect(await jobs.expireListings()).toBeGreaterThanOrEqual(1);
    expect(await status(id)).toBe('expired');
    const [loc] = await db.query(`SELECT purge_after FROM listing_private_location WHERE listing_id = $1`, [id]);
    expect(loc.purge_after).not.toBeNull();
  });

  it('süre bitmeden 3 gün önce bir kez hatırlatma e-postası gider', async () => {
    const { id, plate } = await listing();
    const { email } = await me(owner);
    await db.query(`UPDATE listings SET expires_at = now() + interval '2 days' WHERE id = $1`, [id]);

    await jobs.sendExpiryReminders();
    const sent = mail.sent.filter((m) => m.to === email && m.subject.includes(plate));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('bir kez 30 gün uzatabilirsiniz');

    await jobs.sendExpiryReminders();
    expect(mail.sent.filter((m) => m.to === email && m.subject.includes(plate))).toHaveLength(1);
  });

  it('hatırlatmayı kapatan kullanıcıya e-posta gitmez', async () => {
    const quiet = await verifiedUser(app, mail, 'sessiz');
    await http().patch('/api/v1/me/notification-prefs').auth(quiet, bearer).send({ expiry: false }).expect(200);
    const { id, plate } = await listing(quiet);
    await db.query(`UPDATE listings SET expires_at = now() + interval '1 day' WHERE id = $1`, [id]);
    await jobs.sendExpiryReminders();
    expect(mail.sent.some((m) => m.subject.includes(plate))).toBe(false);
  });

  it('saklama süresi dolan kesin konum silinir, silinen hesabın ilanı kapanır', async () => {
    const a = await listing();
    await db.query(`UPDATE listing_private_location SET purge_after = now() - interval '1 day' WHERE listing_id = $1`, [a.id]);

    const gone = await verifiedUser(app, mail, 'giden');
    const b = await listing(gone);
    await http().delete('/api/v1/me').auth(gone, bearer).expect(202);

    const result = await jobs.purgeRetention();
    expect(result.exactLocations).toBeGreaterThanOrEqual(1);
    expect(await db.query(`SELECT 1 FROM listing_private_location WHERE listing_id = $1`, [a.id])).toHaveLength(0);
    expect(await status(b.id)).toBe('closed');
  });

  it('ilana bağlanmayan fotoğraf 24 saat sonra silinir', async () => {
    const old = await http().post('/api/v1/photos/upload-url').auth(owner, bearer).send({ mime: 'image/png', bytes: 50 }).expect(201);
    const fresh = await http().post('/api/v1/photos/upload-url').auth(owner, bearer).send({ mime: 'image/png', bytes: 50 }).expect(201);
    await db.query(`UPDATE photos SET created_at = now() - interval '25 hours' WHERE id = $1`, [old.body.photoId]);

    await jobs.purgeOrphanPhotos();
    expect(await db.query(`SELECT 1 FROM photos WHERE id = $1`, [old.body.photoId])).toHaveLength(0);
    expect(await db.query(`SELECT 1 FROM photos WHERE id = $1`, [fresh.body.photoId])).toHaveLength(1);
  });

  describe('teslim onayı (FR-069, AC-16)', () => {
    async function handedOver() {
      const { id } = await listing();
      const conv = await http()
        .post('/api/v1/conversations')
        .auth(seeker, bearer)
        .send({ listingId: id, firstMessage: 'Plaka benim', clientId: randomUUID() })
        .expect(201);
      await http().post(`/api/v1/plates/${id}/handover`).auth(owner, bearer).send({ conversationId: conv.body.conversation.id }).expect(200);
      return { id, conversationId: conv.body.conversation.id as string };
    }

    it('arayan "evet" derse ilan onaylı görünür; ikinci yanıt reddedilir', async () => {
      const { id, conversationId } = await handedOver();
      const msgs = await http().get(`/api/v1/conversations/${conversationId}/messages`).auth(seeker, bearer).expect(200);
      expect(msgs.body.at(-1)).toMatchObject({ kind: 'system', senderId: null });

      await http().post(`/api/v1/plates/${id}/handover-confirm`).auth(seeker, bearer).send({ confirmed: true }).expect(200);
      expect((await http().get(`/api/v1/plates/${id}`).expect(200)).body.handoverConfirmed).toBe(true);
      const again = await http().post(`/api/v1/plates/${id}/handover-confirm`).auth(seeker, bearer).send({ confirmed: false }).expect(409);
      expect(again.body.error.code).toBe('HANDOVER_CONFIRM_NOT_ALLOWED');
    });

    it('"hayır" yönetici incelemesine düşer', async () => {
      const { id } = await handedOver();
      await http().post(`/api/v1/plates/${id}/handover-confirm`).auth(seeker, bearer).send({ confirmed: false }).expect(200);
      const [report] = await db.query(`SELECT reason, status FROM reports WHERE listing_id = $1`, [id]);
      expect(report).toEqual({ reason: 'other', status: 'open' });
    });

    it('ilan sahibi ve 7 günü geçen yanıt onay veremez', async () => {
      const { id } = await handedOver();
      await http().post(`/api/v1/plates/${id}/handover-confirm`).auth(owner, bearer).send({ confirmed: true }).expect(409);
      await db.query(`UPDATE listings SET handed_over_at = now() - interval '8 days' WHERE id = $1`, [id]);
      await http().post(`/api/v1/plates/${id}/handover-confirm`).auth(seeker, bearer).send({ confirmed: true }).expect(409);
    });
  });
});
