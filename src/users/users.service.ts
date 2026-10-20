import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DataCipher } from '../common/crypto/data-cipher';
import { ApiError } from '../common/errors/api-error';
import { normalizePhone } from '../common/phone/phone';
import { RateLimiter } from '../common/rate-limit/rate-limiter.service';
import { Me, NotificationPrefs, NotificationPrefsDto, PhoneLast4, UpdateMeDto } from './users.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DataSource,
    private readonly cipher: DataCipher,
    private readonly limiter: RateLimiter,
  ) {}

  async me(userId: string): Promise<Me> {
    const [row] = await this.db.query(
      `SELECT u.id, u.email, u.email_verified AS "emailVerified", u.display_name AS "displayName",
              u.role, u.status, p.phone_last4 AS "phoneLast4", u.created_at AS "createdAt"
       FROM users u LEFT JOIN user_private p ON p.user_id = u.id
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
    );
    if (!row) throw new ApiError(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED', 'Bu işlem için giriş yapmalısınız.');
    return row;
  }

  async update(userId: string, dto: UpdateMeDto): Promise<Me> {
    if (dto.displayName !== undefined) {
      await this.db.query(`UPDATE users SET display_name = $2 WHERE id = $1 AND deleted_at IS NULL`, [
        userId,
        dto.displayName,
      ]);
    }
    return this.me(userId);
  }

  // FR-036: numara şifreli saklanır (NFR-006); kullanıcıya yalnızca son 4 hane döner (T6 §3).
  async phone(userId: string): Promise<PhoneLast4> {
    const [row]: { last4: string }[] = await this.db.query(`SELECT phone_last4 AS last4 FROM user_private WHERE user_id = $1`, [
      userId,
    ]);
    return { last4: row?.last4 ?? null };
  }

  async setPhone(userId: string, input: string): Promise<PhoneLast4> {
    const phone = normalizePhone(input);
    if (!phone) throw new ApiError(HttpStatus.BAD_REQUEST, 'PHONE_INVALID', 'Geçerli bir Türkiye telefon numarası girin.');
    await this.limiter.consume(`phone-set:${userId}`, 10, 86400);
    await this.db.query(
      `INSERT INTO user_private (user_id, phone_enc, phone_last4) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET phone_enc = EXCLUDED.phone_enc, phone_last4 = EXCLUDED.phone_last4`,
      [userId, this.cipher.encrypt(phone), phone.slice(-4)],
    );
    return { last4: phone.slice(-4) };
  }

  // Numara silinince "telefonum görünsün" seçili ilanlarda da artık gösterilmez.
  async deletePhone(userId: string): Promise<void> {
    await this.db.query(`UPDATE user_private SET phone_enc = NULL, phone_last4 = NULL WHERE user_id = $1`, [userId]);
  }

  async notificationPrefs(userId: string): Promise<NotificationPrefs> {
    const [row] = await this.db.query(
      `SELECT new_message AS "newMessage", expiry, plate_alert AS "plateAlert"
       FROM notification_prefs WHERE user_id = $1`,
      [userId],
    );
    return row ?? { newMessage: true, expiry: true, plateAlert: true };
  }

  async updateNotificationPrefs(userId: string, dto: NotificationPrefsDto): Promise<NotificationPrefs> {
    await this.db.query(
      `INSERT INTO notification_prefs (user_id, new_message, expiry, plate_alert)
       VALUES ($1, COALESCE($2, true), COALESCE($3, true), COALESCE($4, true))
       ON CONFLICT (user_id) DO UPDATE SET
         new_message = COALESCE($2, notification_prefs.new_message),
         expiry      = COALESCE($3, notification_prefs.expiry),
         plate_alert = COALESCE($4, notification_prefs.plate_alert)`,
      [userId, dto.newMessage ?? null, dto.expiry ?? null, dto.plateAlert ?? null],
    );
    return this.notificationPrefs(userId);
  }

  // FR-005: kimlik bilgileri hemen silinir, oturumlar kapanır. İlanların kapatılması ve
  // fotoğrafların silinmesi `retention-purge` işiyle (kuyruk) yapılacak.
  async deleteAccount(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users SET status = 'deleted', deleted_at = now(), email = NULL, password_hash = NULL,
                display_name = 'Silinmiş kullanıcı', mfa_secret_enc = NULL
         WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      await tx.query(`DELETE FROM user_identities WHERE user_id = $1`, [userId]);
      await tx.query(`DELETE FROM user_private WHERE user_id = $1`, [userId]);
      await tx.query(`DELETE FROM device_tokens WHERE user_id = $1`, [userId]);
      await tx.query(`DELETE FROM auth_tokens WHERE user_id = $1`, [userId]);
      await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await tx.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1::uuid, 'user.delete', 'user', $1::text)`, [
        userId,
      ]);
    });
  }
}
