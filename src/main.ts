import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { setupApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Coolify'ın Traefik proxy'si arkasında gerçek istemci IP'si için (hız sınırı buna dayanır).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  setupApp(app);
  await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'), '0.0.0.0');
}
bootstrap();
