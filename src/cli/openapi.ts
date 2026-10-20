import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';

// OpenAPI belgesini dosyaya yazar: node dist/cli/openapi.js [çıktı-yolu]
// Uygulama önizleme modunda kurulur; sağlayıcılar örneklenmediği için veritabanı ve Redis gerekmez.
// Ortam doğrulaması yine de çalıştığı için zorunlu değişkenlere yer tutucu verilir.
process.env.DATABASE_URL ??= 'postgres://openapi@localhost/openapi';
process.env.REDIS_URL ??= 'redis://localhost';
process.env.JWT_SECRET ??= 'openapi-placeholder-openapi-placeholder';

async function main(): Promise<void> {
  const { AppModule } = await import('../app.module');
  const { buildOpenApi } = await import('../openapi');
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  app.setGlobalPrefix('api/v1');
  const out = process.argv[2] ?? 'openapi.json';
  writeFileSync(out, `${JSON.stringify(buildOpenApi(app), null, 2)}\n`);
  await app.close();
  console.log(`Yazıldı: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
