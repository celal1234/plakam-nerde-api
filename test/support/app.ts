import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { setupApp } from '../../src/app.setup';
import { MailMessage, MailService } from '../../src/mail/mail.service';
import { REDIS } from '../../src/redis/redis.module';

// Gönderilen e-postaları yakalar; testler bağlantıdaki token'ı buradan okur.
export class FakeMail {
  sent: MailMessage[] = [];
  async send(m: MailMessage) {
    this.sent.push(m);
  }
  lastTo(to: string): MailMessage {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    if (!m) throw new Error(`no mail to ${to}`);
    return m;
  }
  tokenFor(to: string): string {
    const match = /token=([A-Za-z0-9_-]+)/.exec(this.lastTo(to).text);
    if (!match) throw new Error('no token in mail');
    return match[1];
  }
}

export async function createApp(): Promise<{ app: INestApplication; mail: FakeMail }> {
  const mail = new FakeMail();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();
  const app = moduleRef.createNestApplication();
  setupApp(app);
  await app.init();
  // Önceki çalıştırmalardan kalan hız sınırı sayaçlarını temizle.
  const redis = app.get<Redis>(REDIS);
  const keys = await redis.keys('rl:*');
  if (keys.length) await redis.del(...keys);
  return { app, mail };
}

export const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

// Doğrulanmış e-postalı kullanıcı oluşturur ve erişim anahtarını döndürür.
export async function verifiedUser(app: INestApplication, mail: FakeMail, tag: string): Promise<string> {
  const email = uniqueEmail(tag);
  const password = 'cok-gizli-sifre-1';
  await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password, displayName: tag, termsVersion: '2026-10' })
    .expect(201);
  await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ token: mail.tokenFor(email) }).expect(204);
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(200);
  return res.body.accessToken;
}

// Her çalıştırmada farklı plaka; veritabanı çalıştırmalar arasında temizlenmez.
export function randomPlate(): string {
  const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  return `34 ${letters} ${100 + Math.floor(Math.random() * 900)}`;
}
