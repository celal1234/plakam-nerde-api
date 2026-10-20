import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import { REDIS } from '../src/redis/redis.module';
import { createApp, FakeMail, randomPlate, verifiedUser } from './support/app';

const KADIKOY = { lat: 40.9906, lng: 29.0236, source: 'map' as const };

describe('Mesajlaşma (e2e)', () => {
  let app: INestApplication;
  let mail: FakeMail;
  let db: DataSource;
  let base: string;
  let finder: string; // ilan sahibi (plakayı bulan)
  let seeker: string; // plakasını arayan
  const bearer = { type: 'bearer' as const };
  const http = () => request(base);

  beforeAll(async () => {
    ({ app, mail } = await createApp());
    // WebSocket testi gerçek bir port ister.
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    db = app.get(DataSource);
    finder = await verifiedUser(app, mail, 'bulan');
    seeker = await verifiedUser(app, mail, 'arayan');
  });
  afterAll(() => app.close());

  const userId = async (token: string) => (await http().get('/api/v1/me').auth(token, bearer)).body.id as string;

  async function listing(token = finder): Promise<string> {
    // Testler kullanıcı başına günlük ilan sınırını aşar; sınırın kendisi ilan testlerinde.
    const redis = app.get<Redis>(REDIS);
    const keys = await redis.keys('rl:listing-create:*');
    if (keys.length) await redis.del(...keys);
    const photo = await http().post('/api/v1/photos/upload-url').auth(token, bearer).send({ mime: 'image/jpeg', bytes: 100 }).expect(201);
    const res = await http()
      .post('/api/v1/plates')
      .auth(token, bearer)
      .send({ plate: randomPlate(), photoIds: [photo.body.photoId], location: KADIKOY, city: 'İstanbul', foundAt: new Date().toISOString().slice(0, 10), isOfficialPlate: false, showPhone: false })
      .expect(201);
    return res.body.id;
  }

  const start = (token: string, listingId: string, text = 'Merhaba, bu plaka benim.') =>
    http().post('/api/v1/conversations').auth(token, bearer).send({ listingId, firstMessage: text, clientId: randomUUID() });

  const send = (token: string, id: string, body: Record<string, unknown>) =>
    http().post(`/api/v1/conversations/${id}/messages`).auth(token, bearer).send({ clientId: randomUUID(), ...body });

  function connect(token: string): Promise<{ ws: WebSocket; events: Record<string, unknown>[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/ws`);
      const events: Record<string, unknown>[] = [];
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        const e = JSON.parse(raw.toString());
        if (e.type === 'ready') resolve({ ws, events });
        else events.push(e);
      });
      ws.on('close', (code) => reject(new Error(`closed ${code}`)));
    });
  }

  async function until(fn: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('oturumsuz kullanıcı mesaj başlatamaz (AC-13)', async () => {
    const id = await listing();
    const res = await http().post('/api/v1/conversations').send({ listingId: id, firstMessage: 'x', clientId: randomUUID() }).expect(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('konuşma başlar, mesajlar anlık iletilir ve okundu bilgisi gider', async () => {
    const listingId = await listing();
    const finderSocket = await connect(finder);
    const seekerSocket = await connect(seeker);

    const started = await start(seeker, listingId).expect(201);
    const conv = started.body.conversation;
    expect(conv).toMatchObject({ listingId, role: 'seeker', unread: 0, listingStatus: 'active' });
    expect(started.body.message).toMatchObject({ kind: 'text', body: 'Merhaba, bu plaka benim.' });

    await until(() => finderSocket.events.some((e) => e.type === 'message.new'));

    const finderList = await http().get('/api/v1/conversations').auth(finder, bearer).expect(200);
    const mine = finderList.body.find((c: { id: string }) => c.id === conv.id);
    expect(mine).toMatchObject({ role: 'owner', unread: 1, otherUser: { displayName: 'arayan' } });

    const reply = await send(finder, conv.id, { kind: 'text', body: 'Merhaba! Kadıköy iskelesinde buldum.' }).expect(201);
    await until(() => seekerSocket.events.some((e) => e.type === 'message.new' && (e.message as { id: string }).id === reply.body.id));

    const read = await http().post(`/api/v1/conversations/${conv.id}/read`).auth(finder, bearer).expect(200);
    expect(read.body.upToId).toBe(started.body.message.id);
    await until(() => seekerSocket.events.some((e) => e.type === 'message.read'));

    // Koptuktan sonra eşitleme (FR-032).
    const sync = await http().get(`/api/v1/conversations/${conv.id}/messages`).query({ after: started.body.message.id }).auth(seeker, bearer).expect(200);
    expect(sync.body.map((m: { id: string }) => m.id)).toEqual([reply.body.id]);

    finderSocket.ws.close();
    seekerSocket.ws.close();
  });

  it('aynı ilana ikinci başlatma aynı konuşmayı döndürür', async () => {
    const listingId = await listing();
    const a = await start(seeker, listingId).expect(201);
    const b = await start(seeker, listingId, 'Tekrar yazıyorum').expect(201);
    expect(b.body.conversation.id).toBe(a.body.conversation.id);
    const msgs = await http().get(`/api/v1/conversations/${a.body.conversation.id}/messages`).auth(seeker, bearer).expect(200);
    expect(msgs.body).toHaveLength(2);
  });

  it('aynı clientId ile tekrar gönderim çift kayıt oluşturmaz', async () => {
    const { body } = await start(seeker, await listing()).expect(201);
    const clientId = randomUUID();
    const first = await send(seeker, body.conversation.id, { clientId, kind: 'text', body: 'Bir' }).expect(201);
    const again = await send(seeker, body.conversation.id, { clientId, kind: 'text', body: 'Bir' }).expect(201);
    expect(again.body.id).toBe(first.body.id);
  });

  it('kesin konumu yalnızca ilan sahibi paylaşabilir (FR-066)', async () => {
    const { body } = await start(seeker, await listing()).expect(201);
    const id = body.conversation.id;
    const denied = await send(seeker, id, { kind: 'location', point: { lat: 41, lng: 29 } }).expect(403);
    expect(denied.body.error.code).toBe('LOCATION_OWNER_ONLY');
    const ok = await send(finder, id, { kind: 'location', point: { lat: 40.9906, lng: 29.0236 } }).expect(201);
    expect(ok.body.point).toEqual({ lat: 40.9906, lng: 29.0236 });
  });

  it('konuşmayı yalnızca taraflar okur (BR-011)', async () => {
    const { body } = await start(seeker, await listing()).expect(201);
    const stranger = await verifiedUser(app, mail, 'yabanci');
    const res = await http().get(`/api/v1/conversations/${body.conversation.id}/messages`).auth(stranger, bearer).expect(403);
    expect(res.body.error.code).toBe('CONVERSATION_FORBIDDEN');
    await send(stranger, body.conversation.id, { kind: 'text', body: 'selam' }).expect(403);
    await http().get(`/api/v1/conversations/${randomUUID()}/messages`).auth(stranger, bearer).expect(403);
  });

  it('kendi ilanına ve pasif ilana mesaj başlatılamaz', async () => {
    const own = await start(finder, await listing()).expect(400);
    expect(own.body.error.code).toBe('CONVERSATION_SELF');

    const closed = await listing();
    await http().post(`/api/v1/plates/${closed}/close`).auth(finder, bearer).send({ reason: 'mistake' }).expect(200);
    const res = await start(seeker, closed).expect(409);
    expect(res.body.error.code).toBe('LISTING_NOT_ACTIVE');
  });

  it('teslimden sonra yazışma sürer, kapatılınca durur', async () => {
    const listingId = await listing();
    const { body } = await start(seeker, listingId).expect(201);
    await http().post(`/api/v1/plates/${listingId}/handover`).auth(finder, bearer).send({ conversationId: body.conversation.id }).expect(200);
    await send(seeker, body.conversation.id, { kind: 'text', body: 'Aldım, teşekkürler!' }).expect(201);

    const other = await listing();
    const c2 = await start(seeker, other).expect(201);
    await http().post(`/api/v1/plates/${other}/close`).auth(finder, bearer).send({ reason: 'other' }).expect(200);
    const res = await send(seeker, c2.body.conversation.id, { kind: 'text', body: 'Hâlâ orada mı?' }).expect(409);
    expect(res.body.error.code).toBe('LISTING_NOT_ACTIVE');
  });

  it('engellenen kullanıcıyla iki yönde de yazışılamaz (FR-033)', async () => {
    const blocker = await verifiedUser(app, mail, 'engelleyen');
    const listingId = await listing(blocker);
    const { body } = await start(seeker, listingId).expect(201);

    await http().post(`/api/v1/users/${await userId(seeker)}/block`).auth(blocker, bearer).expect(204);
    const a = await send(seeker, body.conversation.id, { kind: 'text', body: 'Merhaba?' }).expect(403);
    expect(a.body.error.code).toBe('USER_BLOCKED');
    const b = await send(blocker, body.conversation.id, { kind: 'text', body: 'x' }).expect(403);
    expect(b.body.error.code).toBe('USER_BLOCKED');
    const c = await start(seeker, await listing(blocker)).expect(403);
    expect(c.body.error.code).toBe('USER_BLOCKED');
  });

  it('kısıtlı kullanıcı mesaj gönderemez (FR-055)', async () => {
    const { body } = await start(seeker, await listing()).expect(201);
    const sid = await userId(seeker);
    await db.query(`UPDATE users SET status = 'restricted', restricted_until = now() + interval '1 day' WHERE id = $1`, [sid]);
    try {
      const res = await send(seeker, body.conversation.id, { kind: 'text', body: 'x' }).expect(403);
      expect(res.body.error.code).toBe('USER_RESTRICTED');
    } finally {
      await db.query(`UPDATE users SET status = 'active', restricted_until = NULL WHERE id = $1`, [sid]);
    }
  });

  it('WebSocket kimliksiz bağlantıyı kapatır', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/ws`);
    const code = await new Promise<number>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'gecersiz' })));
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4401);
  });

  it('dakikada 20 mesaj sınırı (BR-017)', async () => {
    const { body } = await start(seeker, await listing()).expect(201);
    const sid = await userId(seeker);
    await app.get<Redis>(REDIS).del(`rl:message:${sid}`);
    for (let i = 0; i < 20; i++) await send(seeker, body.conversation.id, { kind: 'text', body: `m${i}` }).expect(201);
    const res = await send(seeker, body.conversation.id, { kind: 'text', body: 'fazla' }).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});
