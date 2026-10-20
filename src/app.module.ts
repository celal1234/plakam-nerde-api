import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { envSchema } from './config/env.validation';
import { dataSourceOptions } from './database/data-source';
import { AuthModule } from './auth/auth.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { RedisModule } from './redis/redis.module';
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
    RateLimitModule,
    MailModule,
    HealthModule,
    AuthModule,
    UsersModule,
  ],
})
export class AppModule {}
