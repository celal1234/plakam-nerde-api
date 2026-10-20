import type { MigrationInterface, QueryRunner } from 'typeorm';

// "Gelecek tarih olamaz" kuralı Türkiye saatine göre: 00:00–03:00 arası girilen bugünün tarihi
// UTC'de yarın sayılıp reddediliyordu.
export class ListingsFoundAtIstanbul1760954400000 implements MigrationInterface {
  name = 'ListingsFoundAtIstanbul1760954400000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
ALTER TABLE listings DROP CONSTRAINT listings_found_at_check;
ALTER TABLE listings ADD CONSTRAINT listings_found_at_check
  CHECK (found_at <= (now() AT TIME ZONE 'Europe/Istanbul')::date);
`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
ALTER TABLE listings DROP CONSTRAINT listings_found_at_check;
ALTER TABLE listings ADD CONSTRAINT listings_found_at_check CHECK (found_at <= current_date);
`);
  }
}
