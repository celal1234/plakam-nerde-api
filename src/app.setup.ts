import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { ApiExceptionFilter } from './common/errors/api-exception.filter';
import { validationPipe } from './common/errors/validation';

// main.ts ve e2e testleri aynı ayarlarla çalışsın diye ayrı tutuldu.
export function setupApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  const origins = (config.get<string>('CORS_ORIGINS') ?? '').split(',').filter(Boolean);

  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.enableCors({ origin: origins.length ? origins : false, credentials: true });
  app.useGlobalPipes(validationPipe);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
}
