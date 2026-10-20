import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, FakeMail, uniqueEmail } from './support/app';

describe('Kimlik (e2e)', () => {
  let app: INestApplication;
  let mail: FakeMail;
  const http = () => request(app.getHttpServer());
  const password = 'cok-gizli-sifre-1';

  beforeAll(async () => {
    ({ app, mail } = await createApp());
  });
  afterAll(() => app.close());

  const register = (email: string, extra: Record<string, unknown> = {}) =>
    http()
      .post('/api/v1/auth/register')
      .send({ email, password, displayName: 'Ayşe', termsVersion: '2026-10', ...extra });
  const login = (email: string, pw = password) => http().post('/api/v1/auth/login').send({ email, password: pw });

  it('geçersiz kayıt alan bazında VALIDATION_FAILED döner', async () => {
    const res = await register('bozuk', { password: 'kisa' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual(['email', 'password']);
  });

  it('kayıt → doğrulama → giriş → yenileme akışı', async () => {
    const email = uniqueEmail('akis');
    await register(email.toUpperCase()).expect(201, { status: 'verification_sent' });
    const verifyToken = mail.tokenFor(email);

    // Doğrulamadan önce giriş yapılabilir ama e-posta doğrulanmamış görünür.
    const first = await login(email).expect(200);
    const me1 = await http().get('/api/v1/me').auth(first.body.accessToken, { type: 'bearer' }).expect(200);
    expect(me1.body).toMatchObject({ email, emailVerified: false, displayName: 'Ayşe', role: 'user' });

    await http().post('/api/v1/auth/verify-email').send({ token: verifyToken }).expect(204);
    const again = await http().post('/api/v1/auth/verify-email').send({ token: verifyToken }).expect(400);
    expect(again.body.error.code).toBe('TOKEN_INVALID');

    const second = await http().post('/api/v1/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(200);
    const me2 = await http().get('/api/v1/me').auth(second.body.accessToken, { type: 'bearer' }).expect(200);
    expect(me2.body.emailVerified).toBe(true);
  });

  it('aynı e-postayla ikinci kayıt aynı yanıtı verir ve hesap sahibine haber verir', async () => {
    const email = uniqueEmail('cift');
    await register(email).expect(201);
    await register(email).expect(201, { status: 'verification_sent' });
    expect(mail.lastTo(email).subject).toContain('zaten var');
  });

  it('kullanılmış yenileme anahtarı tekrar gelirse tüm oturum zinciri kapanır', async () => {
    const email = uniqueEmail('calinti');
    await register(email).expect(201);
    const { body: t1 } = await login(email).expect(200);
    const { body: t2 } = await http().post('/api/v1/auth/refresh').send({ refreshToken: t1.refreshToken }).expect(200);

    await http().post('/api/v1/auth/refresh').send({ refreshToken: t1.refreshToken }).expect(401);
    const res = await http().post('/api/v1/auth/refresh').send({ refreshToken: t2.refreshToken }).expect(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('çıkış yenileme anahtarını iptal eder', async () => {
    const email = uniqueEmail('cikis');
    await register(email).expect(201);
    const { body } = await login(email).expect(200);
    await http().post('/api/v1/auth/logout').send({ refreshToken: body.refreshToken }).expect(204);
    await http().post('/api/v1/auth/refresh').send({ refreshToken: body.refreshToken }).expect(401);
  });

  it('tarayıcı modunda refresh token yalnızca httpOnly cookie ile taşınır', async () => {
    const email = uniqueEmail('cerez');
    await register(email).expect(201);
    const browser = { 'X-Token-Transport': 'cookie' };
    const cookieOf = (res: request.Response) => res.get('Set-Cookie')![0];

    const first = await login(email).set(browser).expect(200);
    expect(first.body.refreshToken).toBeUndefined();
    expect(cookieOf(first)).toMatch(/^refresh_token=[^;]+; Max-Age=2592000; Path=\/api\/v1\/auth; .*HttpOnly; Secure; SameSite=Strict/);
    const cookie = cookieOf(first).split(';')[0];

    // Başlık yoksa cookie okunmaz: başka bir site tarayıcıdaki cookie'yle yenileme yaptıramaz.
    await http().post('/api/v1/auth/refresh').set('Cookie', cookie).send({}).expect(401);

    const second = await http().post('/api/v1/auth/refresh').set(browser).set('Cookie', cookie).send({}).expect(200);
    expect(second.body.refreshToken).toBeUndefined();
    await http().get('/api/v1/me').auth(second.body.accessToken, { type: 'bearer' }).expect(200);
    const rotated = cookieOf(second).split(';')[0];
    expect(rotated).not.toBe(cookie);

    const out = await http().post('/api/v1/auth/logout').set(browser).set('Cookie', rotated).expect(204);
    expect(cookieOf(out)).toMatch(/^refresh_token=; Path=\/api\/v1\/auth; Expires=Thu, 01 Jan 1970/);
    await http().post('/api/v1/auth/refresh').set(browser).set('Cookie', rotated).expect(401);
    // Cookie'si olmayan tarayıcı da çıkış yapabilir.
    await http().post('/api/v1/auth/logout').set(browser).expect(204);
  });

  it('hatalı şifre INVALID_CREDENTIALS, 5 denemeden sonra RATE_LIMITED döner', async () => {
    const email = uniqueEmail('kaba');
    await register(email).expect(201);
    for (let i = 0; i < 5; i++) {
      const res = await login(email, 'yanlis-sifre-123').expect(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const res = await login(email).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('olmayan hesapla giriş de INVALID_CREDENTIALS döner', async () => {
    const res = await login(uniqueEmail('yok')).expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('şifre sıfırlama eski oturumları kapatır ve yeni şifreyle giriş açar', async () => {
    const email = uniqueEmail('sifirla');
    await register(email).expect(201);
    const { body: old } = await login(email).expect(200);

    await http().post('/api/v1/auth/password/forgot').send({ email }).expect(204);
    const token = mail.tokenFor(email);
    await http().post('/api/v1/auth/password/reset').send({ token, password: 'yepyeni-sifre-42' }).expect(204);

    await http().post('/api/v1/auth/refresh').send({ refreshToken: old.refreshToken }).expect(401);
    await login(email).expect(401);
    const { body } = await login(email, 'yepyeni-sifre-42').expect(200);
    const me = await http().get('/api/v1/me').auth(body.accessToken, { type: 'bearer' }).expect(200);
    expect(me.body.emailVerified).toBe(true);
  });

  it('olmayan e-posta için şifre sıfırlama da 204 döner', async () => {
    await http().post('/api/v1/auth/password/forgot').send({ email: uniqueEmail('hayalet') }).expect(204);
  });

  it('oturumsuz veya bozuk token ile /me 401 döner', async () => {
    const a = await http().get('/api/v1/me').expect(401);
    expect(a.body.error.code).toBe('AUTH_REQUIRED');
    await http().get('/api/v1/me').auth('bozuk.token.degeri', { type: 'bearer' }).expect(401);
  });

  it('profil ve bildirim tercihleri güncellenir', async () => {
    const email = uniqueEmail('profil');
    await register(email).expect(201);
    const { body } = await login(email).expect(200);
    const auth = { type: 'bearer' as const };

    const me = await http().patch('/api/v1/me').auth(body.accessToken, auth).send({ displayName: '  Mehmet ' }).expect(200);
    expect(me.body.displayName).toBe('Mehmet');

    const prefs = await http()
      .patch('/api/v1/me/notification-prefs')
      .auth(body.accessToken, auth)
      .send({ expiry: false })
      .expect(200);
    expect(prefs.body).toEqual({ newMessage: true, expiry: false, plateAlert: true });
  });

  it('hesap silinince giriş kapanır, aynı e-postayla yeniden kayıt olunabilir', async () => {
    const email = uniqueEmail('sil');
    await register(email).expect(201);
    const { body } = await login(email).expect(200);

    await http().delete('/api/v1/me').auth(body.accessToken, { type: 'bearer' }).expect(202);
    await login(email).expect(401);
    await http().post('/api/v1/auth/refresh').send({ refreshToken: body.refreshToken }).expect(401);

    await register(email).expect(201);
    expect(mail.lastTo(email).subject).toContain('doğrulama');
  });
});
