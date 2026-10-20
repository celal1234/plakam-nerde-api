import type { MigrationInterface, QueryRunner } from 'typeorm';

// Plaka alarmı (FR-062): aynı ilan için bir alarma tek bildirim; kuyruk yeniden denese de çift e-posta gitmez.
export class PlateAlertDeliveries1760965200000 implements MigrationInterface {
  name = 'PlateAlertDeliveries1760965200000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
ALTER TABLE plate_alerts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX plate_alerts_expires ON plate_alerts (expires_at);
CREATE TABLE plate_alert_deliveries (
  alert_id   uuid NOT NULL REFERENCES plate_alerts(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, listing_id)
);
`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
DROP TABLE plate_alert_deliveries;
DROP INDEX plate_alerts_expires;
ALTER TABLE plate_alerts DROP COLUMN created_at;
`);
  }
}
