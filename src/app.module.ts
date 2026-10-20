import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { envSchema } from './config/env.validation';
import { dataSourceOptions } from './database/data-source';
import { AuthModule } from './auth/auth.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { ConversationsModule } from './conversations/conversations.module';
import { HealthModule } from './health/health.module';
import { ListingsModule } from './listings/listings.module';
import { PhotosModule } from './photos/photos.module';
import { MailModule } from './mail/mail.module';
import { QueueModule } from './queue/queue.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...dataSourceOptions(config.getOrThrow('DATABASE_URL'), config.get('DATABASE_SSL') === true),
        autoLoadEntities: true,
        migrationsRun: config.get('RUN_MIGRATIONS') === true,
      }),
    }),
    RedisModule,
    QueueModule,
    RateLimitModule,
    MailModule,
    StorageModule,
    HealthModule,
    AuthModule,
    RealtimeModule,
    UsersModule,
    PhotosModule,
    ListingsModule,
    ConversationsModule,
  ],
})
export class AppModule {}
