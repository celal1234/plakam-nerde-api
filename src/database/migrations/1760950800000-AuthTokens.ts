import type { MigrationInterface, QueryRunner } from 'typeorm';

// Oturum yenileme (rotasyon + yeniden kullanım tespiti) ve tek kullanımlık e-posta bağlantıları.
export class AuthTokens1760950800000 implements MigrationInterface {
  name = 'AuthTokens1760950800000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,                     -- aynı girişten türeyen zincir
  token_hash  bytea NOT NULL,                    -- sha256(gizli kısım)
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,                       -- yenilemede kullanıldı
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);

CREATE TYPE auth_token_purpose AS ENUM ('verify_email','reset_password');

CREATE TABLE auth_tokens (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     auth_token_purpose NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user ON auth_tokens (user_id, purpose);
`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE auth_tokens; DROP TYPE auth_token_purpose; DROP TABLE refresh_tokens;`);
  }
}
