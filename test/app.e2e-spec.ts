import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';

// Gerçek PostGIS veritabanı ister: DATABASE_URL ve REDIS_URL ortamda tanımlı olmalı.
describe('API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
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
