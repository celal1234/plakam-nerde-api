import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from './support/app';

// Gerçek PostGIS veritabanı ister: DATABASE_URL ve REDIS_URL ortamda tanımlı olmalı.
describe('API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createApp());
  });

  afterAll(() => app.close());

  it('GET /api/v1/health veritabanına bağlanır', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body.info.database.status).toBe('up');
  });

  it('bilinmeyen adres T6 hata biçiminde 404 döner', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/yok').expect(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Kayıt bulunamadı.' } });
  });
});
