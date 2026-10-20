import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AlertsProcessor } from '../src/alerts/alerts.processor';
import { REDIS } from '../src/redis/redis.module';
import { createApp, FakeMail, randomPlate, verifiedUser } from './support/app';

const KADIKOY = { lat: 40.9906, lng: 29.0236, source: 'map' as const };

describe('Plaka alarmı (e2e)', () => {
  let app: INestApplication;
  let mail: FakeMail;
  let db: DataSource;
  let finder: string;
  let seeker: string;
  let seekerEmail: string;
  const bearer = { type: 'bearer' as const };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, mail } = await createApp());
    db = app.get(DataSource);
    finder = await verifiedUser(app, mail, 'bulan');
    seeker = await verifiedUser(app, mail, 'arayan');
    seekerEmail = (await http().get('/api/v1/me').auth(seeker, bearer).expect(200)).body.email;
  });
  afterAll(() => app.close());

  async function listing(plate: string, opts: { token?: string; official?: boolean } = {}): Promise<string> {
    const token = opts.token ?? finder;
    const redis = app.get<Redis>(REDIS);
    const keys = await redis.keys('rl:listing-create:*');
    if (keys.length) await redis.del(...keys);
    const photo = await http().post('/api/v1/photos/upload-url').auth(token, bearer).send({ mime: 'image/jpeg', bytes: 100 }).expect(201);
    const res = await http()
      .post('/api/v1/plates')
      .auth(token, bearer)
      .send({ plate, photoIds: [photo.body.photoId], location: KADIKOY, city: 'İstanbul', foundAt: new Date().toISOString().slice(0, 10), isOfficialPlate: opts.official ?? false, showPhone: false })
      .expect(201);
    return res.body.id;
  }

  const alertMails = (plate: string) => mail.sent.filter((m) => m.to === seekerEmail && m.text.includes(plate));

  async function until(fn: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('alarm kurulur, listelenir, aynı plakada yenilenir ve silinir', async () => {
    const plate = randomPlate();
    const a = await http().post('/api/v1/me/alerts').auth(seeker, bearer).send({ plate }).expect(201);
    expect(a.body.plate).toBe(plate.replace(/\s/g, ''));
    const days = (new Date(a.body.expiresAt).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(89);

    const again = await http().post('/api/v1/me/alerts').auth(seeker, bearer).send({ plate: plate.toLowerCase() }).expect(201);
    expect(again.body.id).toBe(a.body.id);
    expect((await http().get('/api/v1/me/alerts').auth(seeker, bearer).expect(200)).body.map((x: { id: string }) => x.id)).toContain(a.body.id);

    await http().delete(`/api/v1/me/alerts/${a.body.id}`).auth(finder, bearer).expect(404);
    await http().delete(`/api/v1/me/alerts/${a.body.id}`).auth(seeker, bearer).expect(204);
    await http().post('/api/v1/me/alerts').auth(seeker, bearer).send({ plate: '---' }).expect(400);
  });

  it('en fazla 10 aktif alarm', async () => {
    const user = await verifiedUser(app, mail, 'cok-alarm');
    for (let i = 0; i < 10; i++) await http().post('/api/v1/me/alerts').auth(user, bearer).send({ plate: randomPlate() }).expect(201);
    expect((await http().post('/api/v1/me/alerts').auth(user, bearer).send({ plate: randomPlate() }).expect(409)).body.error.code).toBe(
      'ALERT_LIMIT_REACHED',
    );
  });

  it('aynı plakaya ilan açılınca alarm sahibine bir kez e-posta gider (AC-18)', async () => {
    const plate = randomPlate();
    await http().post('/api/v1/me/alerts').auth(seeker, bearer).send({ plate }).expect(201);
    const id = await listing(plate);
    await until(() => alertMails(plate).length > 0);
    const m = alertMails(plate)[0];
    expect(m.text).toContain(`https://plakamnerde.test/ilan/${id}`);
    expect(m.text).not.toMatch(/40\.99|29\.02/);

    // İş yeniden çalışsa da ikinci e-posta gitmez.
    expect(await app.get(AlertsProcessor).process(id)).toBe(0);
    expect(alertMails(plate)).toHaveLength(1);
  });

  it('kendi ilanı ve bildirim tercihi kapalıysa e-posta gitmez', async () => {
    const plate = randomPlate();
    await http().post('/api/v1/me/alerts').auth(seeker, bearer).send({ plate }).expect(201);
    const own = await listing(plate, { token: seeker });
    expect(await app.get(AlertsProcessor).process(own)).toBe(0);

    await http().patch('/api/v1/me/notification-prefs').auth(seeker, bearer).send({ plateAlert: false }).expect(200);
    const other = await listing(plate);
    expect(await app.get(AlertsProcessor).process(other)).toBe(0);
    expect(alertMails(plate)).toHaveLength(0);
    await http().patch('/api/v1/me/notification-prefs').auth(seeker, bearer).send({ plateAlert: true }).expect(200);
  });

  it('onay bekleyen ilan yönetici onayına kadar alarm tetiklemez', async () => {
    const plate = randomPlate();
    await http().post('/api/v1/me/alerts').auth(seeker, bearer).send({ plate }).expect(201);
    const id = await listing(plate, { official: true });
    expect(await app.get(AlertsProcessor).process(id)).toBe(0);

    await db.query(`UPDATE listings SET status = 'active' WHERE id = $1`, [id]);
    expect(await app.get(AlertsProcessor).process(id)).toBe(1);
    expect(alertMails(plate)).toHaveLength(1);
  });

  it('süresi dolan alarm eşleşmez ve temizlik işinde silinir', async () => {
    const plate = randomPlate();
    const a = await http().post('/api/v1/me/alerts').auth(seeker, bearer).send({ plate }).expect(201);
    await db.query(`UPDATE plate_alerts SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.body.id]);
    const id = await listing(plate);
    expect(await app.get(AlertsProcessor).process(id)).toBe(0);
    expect((await http().get('/api/v1/me/alerts').auth(seeker, bearer).expect(200)).body.map((x: { id: string }) => x.id)).not.toContain(
      a.body.id,
    );
  });
});
