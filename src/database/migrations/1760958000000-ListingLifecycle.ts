import type { MigrationInterface, QueryRunner } from 'typeorm';

// Teslim onayı penceresi (FR-069) ve tek seferlik süre hatırlatması için zaman damgaları.
export class ListingLifecycle1760958000000 implements MigrationInterface {
  name = 'ListingLifecycle1760958000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
ALTER TABLE listings ADD COLUMN handed_over_at timestamptz;
ALTER TABLE listings ADD COLUMN expiry_reminded_at timestamptz;
CREATE INDEX listings_active_expiry ON listings (expires_at) WHERE status = 'active';
CREATE INDEX lpl_purge ON listing_private_location (purge_after) WHERE purge_after IS NOT NULL;
CREATE INDEX photos_orphan ON photos (created_at) WHERE listing_id IS NULL;
`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
DROP INDEX photos_orphan; DROP INDEX lpl_purge; DROP INDEX listings_active_expiry;
ALTER TABLE listings DROP COLUMN expiry_reminded_at;
ALTER TABLE listings DROP COLUMN handed_over_at;
`);
  }
}
