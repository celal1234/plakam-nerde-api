import { HttpStatus } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ApiError } from './errors/api-error';

// FR-055: kısıtlanmış kullanıcı kısıt süresince ilan veremez, konuşma başlatamaz ve mesaj yazamaz; arama serbesttir.
export async function assertCanWrite(db: Pick<EntityManager, 'query'>, userId: string): Promise<void> {
  const [u]: { restricted: boolean }[] = await db.query(
    `SELECT status = 'banned' OR (status = 'restricted' AND (restricted_until IS NULL OR restricted_until > now())) AS restricted
     FROM users WHERE id = $1`,
    [userId],
  );
  if (!u || u.restricted) {
    throw new ApiError(HttpStatus.FORBIDDEN, 'USER_RESTRICTED', 'Hesabınız geçici olarak kısıtlandı.');
  }
}
