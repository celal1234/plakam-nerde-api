import type { MigrationInterface, QueryRunner } from 'typeorm';

// T6 teknik şartname §2'deki şemanın birebir ilk hali.
export class InitialSchema1760947200000 implements MigrationInterface {
  name = 'InitialSchema1760947200000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_role       AS ENUM ('user','admin');
CREATE TYPE user_status     AS ENUM ('active','restricted','banned','deleted');
CREATE TYPE auth_provider   AS ENUM ('email','google','apple');
CREATE TYPE listing_status  AS ENUM ('pending','active','handed_over','closed','expired','removed');
CREATE TYPE close_reason    AS ENUM ('handed_over_elsewhere','given_to_police','mistake','other');
CREATE TYPE report_reason   AS ENUM ('fake','wrong_plate','inappropriate_photo','personal_data','harassment','spam','other');
CREATE TYPE report_status   AS ENUM ('open','resolved_action','resolved_no_action');

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext UNIQUE,
  email_verified   boolean NOT NULL DEFAULT false,
  password_hash    text,                         -- argon2id; sosyal girişte NULL
  display_name     text NOT NULL,
  role             user_role   NOT NULL DEFAULT 'user',
  status           user_status NOT NULL DEFAULT 'active',
  restricted_until timestamptz,
  mfa_secret_enc   bytea,                        -- yalnızca admin
  terms_version    text NOT NULL,
  terms_accepted_at timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE user_identities (                   -- Google / Apple
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  provider    auth_provider NOT NULL,
  provider_uid text NOT NULL,
  PRIMARY KEY (provider, provider_uid)
);

CREATE TABLE user_private (                      -- NFR-006: ayrı, erişim kontrollü
  user_id   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone_enc bytea,                               -- uygulama katmanında AES-256-GCM
  phone_last4 text
);

CREATE TABLE listings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id),
  plate_normalized text NOT NULL,                -- 34ABC123
  plate_display    text NOT NULL,                -- kullanıcının yazdığı
  plate_format_ok  boolean NOT NULL,
  is_official_plate boolean NOT NULL DEFAULT false,  -- FR-059
  status           listing_status NOT NULL,
  found_at         date NOT NULL CHECK (found_at <= current_date),
  public_point     geography(Point,4326) NOT NULL,   -- K4: kaydırılmış, sabit
  public_radius_m  int NOT NULL DEFAULT 500,
  district         text, city text NOT NULL,
  show_phone       boolean NOT NULL DEFAULT false,   -- FR-038
  expires_at       timestamptz NOT NULL,
  extended_at      timestamptz,                      -- BR-013: tek uzatma
  closed_reason    close_reason,
  handover_conversation_id uuid,
  handover_confirmed boolean,                        -- K6: NULL=sorulmadı/bekliyor
  hidden_by_reports boolean NOT NULL DEFAULT false,  -- FR-072
  version          int NOT NULL DEFAULT 1,           -- NFR-012 iyimser kilit
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_plate_status ON listings (plate_normalized, status);
CREATE INDEX listings_public_point ON listings USING gist (public_point);

CREATE TABLE listing_private_location (          -- kesin konum, ayrı tablo
  listing_id uuid PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  exact_point geography(Point,4326) NOT NULL,
  purge_after timestamptz                        -- kapanış + 90 gün
);
CREATE INDEX lpl_exact ON listing_private_location USING gist (exact_point);

CREATE TABLE photos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid REFERENCES listings(id) ON DELETE SET NULL,
  uploader_id uuid NOT NULL REFERENCES users(id),
  storage_key text NOT NULL,                     -- orijinal (EXIF temizlenmiş)
  thumb_key  text,
  mime       text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/heic')),
  bytes      int  NOT NULL CHECK (bytes <= 10485760),
  position   smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES listings(id),
  owner_id    uuid NOT NULL REFERENCES users(id),
  seeker_id   uuid NOT NULL REFERENCES users(id),
  read_only   boolean NOT NULL DEFAULT false,
  last_message_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, seeker_id),
  CHECK (owner_id <> seeker_id)
);

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid REFERENCES users(id),
  kind            text NOT NULL CHECK (kind IN ('text','location','system')),
  body            text CHECK (char_length(body) <= 2000),
  point           geography(Point,4326),           -- FR-066
  client_id       uuid NOT NULL,                   -- tekrar gönderimde çift kayıt önler
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,
  UNIQUE (conversation_id, client_id)
);

CREATE TABLE blocks (
  blocker_id uuid REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE plate_alerts (                      -- FR-062
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plate_normalized text NOT NULL,
  expires_at       timestamptz NOT NULL,         -- +90 gün
  UNIQUE (user_id, plate_normalized)
);
CREATE INDEX plate_alerts_plate ON plate_alerts (plate_normalized);

CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id),
  listing_id  uuid REFERENCES listings(id),
  target_user_id uuid REFERENCES users(id),
  conversation_id uuid REFERENCES conversations(id),
  reason      report_reason NOT NULL,
  note        text CHECK (char_length(note) <= 1000),
  status      report_status NOT NULL DEFAULT 'open',
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(listing_id, target_user_id, conversation_id) >= 1)
);
CREATE UNIQUE INDEX one_report_per_user_listing ON reports (reporter_id, listing_id) WHERE listing_id IS NOT NULL;

CREATE TABLE device_tokens (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  platform text CHECK (platform IN ('ios','android','web')),
  token   text NOT NULL,
  PRIMARY KEY (user_id, token)
);

CREATE TABLE notification_prefs (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  new_message boolean NOT NULL DEFAULT true,
  expiry      boolean NOT NULL DEFAULT true,
  plate_alert boolean NOT NULL DEFAULT true
);

CREATE TABLE audit_log (                         -- FR-056, 2 yıl
  id         bigserial PRIMARY KEY,
  actor_id   uuid,
  action     text NOT NULL,                      -- ör. admin.listing.remove, pii.phone.view
  target_type text, target_id text,
  meta       jsonb,
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);
-- listing_ttl_days=30, extension_days=30, dup_radius_m=2000, report_hide_threshold=3
`);
    await q.query(`
INSERT INTO settings (key, value) VALUES
  ('listing_ttl_days', '30'),
  ('extension_days', '30'),
  ('dup_radius_m', '2000'),
  ('report_hide_threshold', '3');
`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
DROP TABLE IF EXISTS settings, audit_log, notification_prefs, device_tokens, reports, plate_alerts,
  blocks, messages, conversations, photos, listing_private_location, listings, user_private,
  user_identities, users CASCADE;
DROP TYPE IF EXISTS report_status, report_reason, close_reason, listing_status, auth_provider,
  user_status, user_role;
`);
  }
}
