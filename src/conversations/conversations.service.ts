import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../auth/auth.decorators';
import { ApiError } from '../common/errors/api-error';
import { assertCanWrite } from '../common/restriction';
import { RateLimiter } from '../common/rate-limit/rate-limiter.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MessagesQueryDto, SendMessageDto, StartConversationDto } from './conversations.dto';

const MESSAGE_COLUMNS = `
  m.id::text AS id, m.conversation_id AS "conversationId", m.sender_id AS "senderId", m.kind, m.body,
  CASE WHEN m.point IS NULL THEN NULL
       ELSE json_build_object('lat', ST_Y(m.point::geometry), 'lng', ST_X(m.point::geometry)) END AS point,
  m.client_id AS "clientId", m.created_at AS "createdAt", m.read_at AS "readAt"`;

interface ConversationRow {
  id: string;
  listing_id: string;
  owner_id: string;
  seeker_id: string;
  read_only: boolean;
  listing_status: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string | null;
  kind: 'text' | 'location' | 'system';
  body: string | null;
  point: { lat: number; lng: number } | null;
  clientId: string;
  createdAt: Date;
  readAt: Date | null;
}

const forbidden = () =>
  new ApiError(HttpStatus.FORBIDDEN, 'CONVERSATION_FORBIDDEN', 'Bu konuşmaya erişiminiz yok.');

@Injectable()
export class ConversationsService {
  constructor(
    private readonly db: DataSource,
    private readonly limiter: RateLimiter,
    private readonly realtime: RealtimeService,
  ) {}

  // AC-13: oturumsuz kullanıcı buraya ulaşamaz (401), istemci girişe yönlendirir.
  async start(user: AuthUser, dto: StartConversationDto) {
    await assertCanWrite(this.db, user.id);
    const [listing]: { owner_id: string; active: boolean }[] = await this.db.query(
      `SELECT owner_id, (status = 'active' AND expires_at > now() AND NOT hidden_by_reports) AS active
       FROM listings WHERE id = $1`,
      [dto.listingId],
    );
    if (!listing) throw new ApiError(HttpStatus.NOT_FOUND, 'LISTING_NOT_FOUND', 'İlan bulunamadı.');
    if (!listing.active) throw new ApiError(HttpStatus.CONFLICT, 'LISTING_NOT_ACTIVE', 'Bu ilan artık aktif değil.');
    if (listing.owner_id === user.id) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'CONVERSATION_SELF', 'Kendi ilanınıza mesaj gönderemezsiniz.');
    }
    await this.assertNotBlocked(this.db.manager, user.id, listing.owner_id);

    const [existing]: { id: string }[] = await this.db.query(
      `SELECT id FROM conversations WHERE listing_id = $1 AND seeker_id = $2`,
      [dto.listingId, user.id],
    );
    if (!existing) await this.limiter.consume(`conversation-new:${user.id}`, 20, 86400); // BR-017

    const { conversationId, message, created } = await this.db.transaction(async (tx) => {
      const [conv]: { id: string }[] = existing
        ? [existing]
        : await tx.query(
            `INSERT INTO conversations (listing_id, owner_id, seeker_id) VALUES ($1, $2, $3)
             ON CONFLICT (listing_id, seeker_id) DO UPDATE SET listing_id = EXCLUDED.listing_id
             RETURNING id`,
            [dto.listingId, listing.owner_id, user.id],
          );
      const { message, created } = await this.insertMessage(tx, conv.id, user.id, {
        clientId: dto.clientId,
        kind: 'text',
        body: dto.firstMessage,
      });
      return { conversationId: conv.id, message, created };
    });

    if (created) await this.realtime.publish([listing.owner_id, user.id], { type: 'message.new', message });
    return { conversation: await this.summary(user.id, conversationId), message };
  }

  async list(user: AuthUser) {
    return this.db.query(
      `${this.summarySql('(c.owner_id = $1 OR c.seeker_id = $1)')}
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT 100`,
      [user.id],
    );
  }

  async messages(user: AuthUser, conversationId: string, q: MessagesQueryDto): Promise<Message[]> {
    await this.loadAsParty(this.db.manager, user.id, conversationId);
    const limit = q.limit ?? 50;
    if (q.after !== undefined) {
      return this.db.query(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.conversation_id = $1 AND m.id > $2 ORDER BY m.id ASC LIMIT $3`,
        [conversationId, q.after, limit],
      );
    }
    const rows: Message[] = await this.db.query(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m
       WHERE m.conversation_id = $1 AND ($2::bigint IS NULL OR m.id < $2) ORDER BY m.id DESC LIMIT $3`,
      [conversationId, q.before ?? null, limit],
    );
    return rows.reverse();
  }

  async send(user: AuthUser, conversationId: string, dto: SendMessageDto): Promise<Message> {
    await assertCanWrite(this.db, user.id);
    const conv = await this.loadAsParty(this.db.manager, user.id, conversationId);
    if (conv.read_only) throw forbidden();
    // Teslimden sonra da taraflar buluşmayı ayarlayabilsin diye `handed_over` ilanda yazışma açık kalır.
    if (!['active', 'handed_over'].includes(conv.listing_status)) {
      throw new ApiError(HttpStatus.CONFLICT, 'LISTING_NOT_ACTIVE', 'Bu ilan artık aktif değil.');
    }
    const other = conv.owner_id === user.id ? conv.seeker_id : conv.owner_id;
    await this.assertNotBlocked(this.db.manager, user.id, other);
    // FR-066: kesin konumu yalnızca bulan kişi (ilan sahibi) paylaşabilir.
    if (dto.kind === 'location' && conv.owner_id !== user.id) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'LOCATION_OWNER_ONLY', 'Konumu yalnızca ilan sahibi paylaşabilir.');
    }
    await this.limiter.consume(`message:${user.id}`, 20, 60); // BR-017

    const { message, created } = await this.db.transaction((tx) => this.insertMessage(tx, conversationId, user.id, dto));
    if (created) await this.realtime.publish([conv.owner_id, conv.seeker_id], { type: 'message.new', message });
    return message;
  }

  async markRead(user: AuthUser, conversationId: string): Promise<{ upToId: string | null }> {
    const conv = await this.loadAsParty(this.db.manager, user.id, conversationId);
    // Sorgu SELECT ile bittiği için TypeORM düz satır dizisi döndürür.
    const [row]: { max: string | null }[] = await this.db.query(
      `WITH updated AS (
         UPDATE messages SET read_at = now()
         WHERE conversation_id = $1 AND sender_id IS DISTINCT FROM $2 AND read_at IS NULL
         RETURNING id)
       SELECT max(id)::text AS max FROM updated`,
      [conversationId, user.id],
    );
    if (row?.max) {
      const other = conv.owner_id === user.id ? conv.seeker_id : conv.owner_id;
      await this.realtime.publish([other], { type: 'message.read', conversationId, upToId: row.max, readerId: user.id });
    }
    return { upToId: row?.max ?? null };
  }

  async block(user: AuthUser, targetId: string): Promise<void> {
    if (targetId === user.id) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Kendinizi engelleyemezsiniz.');
    }
    const [target] = await this.db.query(`SELECT 1 FROM users WHERE id = $1`, [targetId]);
    if (!target) throw new ApiError(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'Kullanıcı bulunamadı.');
    await this.db.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      user.id,
      targetId,
    ]);
  }

  private async insertMessage(
    tx: EntityManager,
    conversationId: string,
    senderId: string,
    dto: Pick<SendMessageDto, 'clientId' | 'kind' | 'body' | 'point'>,
  ): Promise<{ message: Message; created: boolean }> {
    const isLocation = dto.kind === 'location';
    const inserted: Message[] = await tx.query(
      `WITH ins AS (
         INSERT INTO messages (conversation_id, sender_id, kind, body, point, client_id)
         VALUES ($1, $2, $3, $4,
                 CASE WHEN $5::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography END,
                 $7)
         ON CONFLICT (conversation_id, client_id) DO NOTHING
         RETURNING *)
       SELECT ${MESSAGE_COLUMNS} FROM ins m`,
      [
        conversationId,
        senderId,
        dto.kind,
        isLocation ? null : dto.body,
        isLocation ? dto.point!.lat : null,
        isLocation ? dto.point!.lng : null,
        dto.clientId,
      ],
    );
    if (inserted.length) {
      await tx.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
      return { message: inserted[0], created: true };
    }
    // Aynı clientId ile tekrar gönderim: ilk kayıt döner, bildirim tekrarlanmaz.
    const [existing]: Message[] = await tx.query(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.conversation_id = $1 AND m.client_id = $2`,
      [conversationId, dto.clientId],
    );
    return { message: existing, created: false };
  }

  private async loadAsParty(tx: EntityManager, userId: string, conversationId: string): Promise<ConversationRow> {
    const [conv]: ConversationRow[] = await tx.query(
      `SELECT c.id, c.listing_id, c.owner_id, c.seeker_id, c.read_only,
              CASE WHEN l.status = 'active' AND l.expires_at <= now() THEN 'expired' ELSE l.status::text END AS listing_status
       FROM conversations c JOIN listings l ON l.id = c.listing_id
       WHERE c.id = $1 AND (c.owner_id = $2 OR c.seeker_id = $2)`,
      [conversationId, userId],
    );
    // Var olmayan ve başkasına ait konuşma aynı yanıtı alır (BR-011).
    if (!conv) throw forbidden();
    return conv;
  }

  private async assertNotBlocked(tx: EntityManager, a: string, b: string): Promise<void> {
    const [row] = await tx.query(
      `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [a, b],
    );
    if (row) throw new ApiError(HttpStatus.FORBIDDEN, 'USER_BLOCKED', 'Bu kullanıcıyla mesajlaşamazsınız.');
  }

  private async summary(userId: string, conversationId: string) {
    const [row] = await this.db.query(`${this.summarySql('c.id = $2 AND (c.owner_id = $1 OR c.seeker_id = $1)')}`, [
      userId,
      conversationId,
    ]);
    return row;
  }

  private summarySql(where: string): string {
    return `
      SELECT c.id, c.listing_id AS "listingId", l.plate_display AS "plateDisplay",
             CASE WHEN l.status = 'active' AND l.expires_at <= now() THEN 'expired' ELSE l.status::text END AS "listingStatus",
             CASE WHEN c.owner_id = $1 THEN 'owner' ELSE 'seeker' END AS role,
             json_build_object('id', other.id, 'displayName', other.display_name) AS "otherUser",
             c.read_only AS "readOnly", c.last_message_at AS "lastMessageAt",
             (SELECT json_build_object('kind', m.kind, 'body', left(m.body, 120), 'senderId', m.sender_id, 'createdAt', m.created_at)
                FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS "lastMessage",
             (SELECT count(*)::int FROM messages m
                WHERE m.conversation_id = c.id AND m.sender_id IS DISTINCT FROM $1 AND m.read_at IS NULL) AS unread
      FROM conversations c
      JOIN listings l ON l.id = c.listing_id
      JOIN users other ON other.id = CASE WHEN c.owner_id = $1 THEN c.seeker_id ELSE c.owner_id END
      WHERE ${where}`;
  }
}
