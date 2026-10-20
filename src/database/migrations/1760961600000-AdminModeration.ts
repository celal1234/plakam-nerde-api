import type { MigrationInterface, QueryRunner } from 'typeorm';

// Yönetici MFA oturumu, şikâyet kuyruğu indeksleri ve panel metrikleri için günlük sayaçlar (FR-057, FR-072, FR-074).
export class AdminModeration1760961600000 implements MigrationInterface {
  name = 'AdminModeration1760961600000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
ALTER TABLE refresh_tokens ADD COLUMN mfa_at timestamptz;
CREATE INDEX reports_status_created ON reports (status, created_at);
CREATE INDEX reports_open_listing ON reports (listing_id) WHERE status = 'open';
CREATE TABLE metric_daily (
  day   date NOT NULL,
  key   text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
DROP TABLE metric_daily;
DROP INDEX reports_open_listing; DROP INDEX reports_status_created;
ALTER TABLE refresh_tokens DROP COLUMN mfa_at;
`);
  }
}
