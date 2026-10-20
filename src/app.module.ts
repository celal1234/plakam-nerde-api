import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { envSchema } from './config/env.validation';
import { dataSourceOptions } from './database/data-source';
import { HealthModule } from './health/health.module';

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
    HealthModule,
  ],
})
export class AppModule {}
