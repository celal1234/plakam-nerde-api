import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { migrations } from './migrations';

export function dataSourceOptions(url: string, ssl: boolean): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    ssl: ssl ? { rejectUnauthorized: true } : false,
    migrations,
    migrationsTableName: 'typeorm_migrations',
    // Şema yalnızca migration ile değişir; senkronizasyon hiçbir ortamda açık değil.
    synchronize: false,
  };
}

// TypeORM CLI (`pnpm migration:run`) bu dışa aktarımı kullanır.
export default new DataSource(
  dataSourceOptions(process.env.DATABASE_URL ?? '', process.env.DATABASE_SSL === 'true'),
);
