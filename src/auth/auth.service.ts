import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { DataSource, EntityManager } from 'typeorm';
import { ApiError } from '../common/errors/api-error';
import { RateLimiter } from '../common/rate-limit/rate-limiter.service';
import { MailService } from '../mail/mail.service';
import { AuthUser } from './auth.decorators';
import { LoginDto, RegisterDto, TokenPair } from './auth.dto';
import { randomToken, sha256 } from './crypto';

const ACCESS_TTL = '15m';
export const REFRESH_TTL_DAYS = 30;
const VERIFY_TTL_HOURS = 24;
const RESET_TTL_HOURS = 1;
// Yönetici MFA doğrulaması bu süre boyunca refresh ile taşınır; sonra panel kodu yeniden ister (FR-057).
const MFA_SESSION_HOURS = 12;

interface RefreshRow {
  user_id: string;
  family_id: string;
  token_hash: Buffer;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  mfa_at: Date | null;
}

interface UserRow {
  id: string;
  role: AuthUser['role'];
  status: 'active' | 'restricted' | 'banned' | 'deleted';
  email_verified: boolean;
  password_hash: string | null;
}

const invalidSession = () =>
  new ApiError(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED', 'Oturumunuz geçersiz, lütfen yeniden giriş yapın.');

@Injectable()
export class AuthService {
  // Olmayan e-postayla girişte de aynı sürede yanıt vermek için (kullanıcı varlığını sızdırmamak).
  private readonly dummyHash = hash('plakam-nerde-dummy-password');
  private readonly appUrl: string;

  constructor(
    private readonly db: DataSource,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly limiter: RateLimiter,
    config: ConfigService,
  ) {
    this.appUrl = config.getOrThrow<string>('APP_URL');
  }

  async register(dto: RegisterDto): Promise<void> {
    const passwordHash = await hash(dto.password);
    const userId = await this.db.transaction(async (tx) => {
      const rows: { id: string }[] = await tx.query(
        `INSERT INTO users (email, password_hash, display_name, terms_version, terms_accepted_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [dto.email, passwordHash, dto.displayName, dto.termsVersion],
      );
      if (!rows.length) return null;
      const id = rows[0].id;
      await tx.query(`INSERT INTO user_identities (user_id, provider, provider_uid) VALUES ($1, 'email', $2)`, [
        id,
        dto.email,
      ]);
      await tx.query(`INSERT INTO notification_prefs (user_id) VALUES ($1)`, [id]);
      return id;
    });

    // Var olan e-postada da aynı yanıt dönülür; sahibine bilgilendirme gider.
    if (!userId) {
      await this.mail.send({
        to: dto.email,
        subject: 'Plakam Nerde? hesabınız zaten var',
        text: `Bu e-posta adresiyle zaten bir hesabınız var. Şifrenizi unuttuysanız uygulamadaki "Şifremi unuttum" bağlantısını kullanın.`,
      });
      return;
    }
    await this.sendVerification(userId, dto.email);
  }

  async resendVerification(user: AuthUser): Promise<void> {
    if (user.emailVerified) return;
    await this.limiter.consume(`verify-resend:${user.id}`, 3, 3600);
    const [row]: { email: string; email_verified: boolean }[] = await this.db.query(
      `SELECT email, email_verified FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [user.id],
    );
    if (row && !row.email_verified) await this.sendVerification(user.id, row.email);
  }

  async verifyEmail(token: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const userId = await this.consumeToken(tx, token, 'verify_email');
      await tx.query(`UPDATE users SET email_verified = true WHERE id = $1`, [userId]);
    });
  }

  async login(dto: LoginDto, ip: string): Promise<TokenPair> {
    await this.limiter.consume(`login:${ip}:${dto.email}`, 5, 60);
    const [user]: UserRow[] = await this.db.query(
      `SELECT id, role, status, email_verified, password_hash FROM users
       WHERE email = $1 AND deleted_at IS NULL`,
      [dto.email],
    );
    const ok = await verify(user?.password_hash ?? (await this.dummyHash), dto.password);
    if (!user?.password_hash || !ok) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'E-posta veya şifre hatalı.');
    }
    this.assertCanSignIn(user);
    return this.issueTokens(this.db.manager, user, crypto.randomUUID());
  }

  async refresh(refreshToken: string | undefined): Promise<TokenPair> {
    const [id, secret] = (refreshToken ?? '').split('.');
    if (!id || !secret || !/^[0-9a-f-]{36}$/.test(id)) throw invalidSession();

    let reusedFamily: string | undefined;
    try {
      return await this.db.transaction(async (tx) => {
        const [row]: RefreshRow[] = await tx.query(`SELECT * FROM refresh_tokens WHERE id = $1 FOR UPDATE`, [id]);
        if (!row || !row.token_hash.equals(sha256(secret))) throw invalidSession();

        if (row.used_at || row.revoked_at) {
          reusedFamily = row.family_id;
          throw invalidSession();
        }
        if (row.expires_at < new Date()) {
          throw new ApiError(HttpStatus.UNAUTHORIZED, 'TOKEN_EXPIRED', 'Oturumunuzun süresi doldu, yeniden giriş yapın.');
        }

        const [user]: UserRow[] = await tx.query(
          `SELECT id, role, status, email_verified, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
          [row.user_id],
        );
        if (!user) throw invalidSession();
        this.assertCanSignIn(user);

        await tx.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [id]);
        return this.issueTokens(tx, user, row.family_id, row.mfa_at);
      });
    } finally {
      // Daha önce kullanılmış bir token tekrar geldiyse çalınmış olabilir: tüm zinciri iptal et (T6 §5).
      // Hata işlemi geri aldığı için iptal, işlemin dışında yapılır.
      if (reusedFamily) await this.revokeFamily(this.db.manager, reusedFamily);
    }
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    const [id, secret] = (refreshToken ?? '').split('.');
    if (!id || !secret || !/^[0-9a-f-]{36}$/.test(id)) return;
    const [row]: { family_id: string; token_hash: Buffer }[] = await this.db.query(
      `SELECT family_id, token_hash FROM refresh_tokens WHERE id = $1`,
      [id],
    );
    if (row?.token_hash.equals(sha256(secret))) await this.revokeFamily(this.db.manager, row.family_id);
  }

  async forgotPassword(email: string, ip: string): Promise<void> {
    await this.limiter.consume(`forgot:${ip}`, 10, 3600);
    await this.limiter.consume(`forgot:${email}`, 3, 3600);
    const [user]: { id: string }[] = await this.db.query(
      `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL AND password_hash IS NOT NULL`,
      [email],
    );
    if (!user) return;
    const token = await this.createToken(user.id, 'reset_password', RESET_TTL_HOURS);
    await this.mail.send({
      to: email,
      subject: 'Plakam Nerde? şifre sıfırlama',
      text: `Şifrenizi sıfırlamak için bağlantıyı açın (1 saat geçerli):\n${this.appUrl}/sifre-sifirla?token=${token}\n\nBu isteği siz yapmadıysanız bu e-postayı yok sayın.`,
    });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const passwordHash = await hash(password);
    await this.db.transaction(async (tx) => {
      const userId = await this.consumeToken(tx, token, 'reset_password');
      // Sıfırlama bağlantısı e-postaya gittiği için adres de doğrulanmış sayılır.
      await tx.query(`UPDATE users SET password_hash = $2, email_verified = true WHERE id = $1`, [userId, passwordHash]);
      await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    });
  }

  private assertCanSignIn(user: UserRow): void {
    if (user.status === 'banned') {
      throw new ApiError(HttpStatus.FORBIDDEN, 'USER_RESTRICTED', 'Hesabınız kapatılmıştır.');
    }
  }

  // TOTP kodu doğrulanmış yönetici için `mfa` işaretli yeni bir oturum zinciri açar.
  async startMfaSession(userId: string): Promise<TokenPair> {
    const [user]: UserRow[] = await this.db.query(
      `SELECT id, role, status, email_verified, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!user) throw invalidSession();
    this.assertCanSignIn(user);
    return this.issueTokens(this.db.manager, user, crypto.randomUUID(), new Date());
  }

  private async issueTokens(tx: EntityManager, user: UserRow, familyId: string, mfaAt: Date | null = null): Promise<TokenPair> {
    const secret = randomToken();
    const [{ id }]: { id: string }[] = await tx.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, mfa_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4), $5) RETURNING id`,
      [user.id, familyId, sha256(secret), REFRESH_TTL_DAYS, mfaAt],
    );
    const mfa = user.role === 'admin' && !!mfaAt && Date.now() - mfaAt.getTime() < MFA_SESSION_HOURS * 3600_000;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role, ev: user.email_verified, ...(mfa ? { mfa: true } : {}) },
      { expiresIn: ACCESS_TTL },
    );
    return { accessToken, refreshToken: `${id}.${secret}` };
  }

  private async revokeFamily(tx: EntityManager, familyId: string): Promise<void> {
    await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [familyId]);
  }

  private async sendVerification(userId: string, email: string): Promise<void> {
    const token = await this.createToken(userId, 'verify_email', VERIFY_TTL_HOURS);
    await this.mail.send({
      to: email,
      subject: 'Plakam Nerde? e-posta doğrulama',
      text: `Hesabınızı etkinleştirmek için bağlantıyı açın (24 saat geçerli):\n${this.appUrl}/dogrula?token=${token}`,
    });
  }

  private async createToken(userId: string, purpose: 'verify_email' | 'reset_password', hours: number): Promise<string> {
    const token = randomToken();
    await this.db.query(
      `INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [sha256(token), userId, purpose, hours],
    );
    return token;
  }

  private async consumeToken(tx: EntityManager, token: string, purpose: string): Promise<string> {
    // TypeORM, postgres'te UPDATE için [satırlar, etkilenen sayı] döndürür.
    const [rows]: [{ user_id: string }[], number] = await tx.query(
      `UPDATE auth_tokens SET used_at = now()
       WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [sha256(token), purpose],
    );
    if (!rows.length) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'TOKEN_INVALID', 'Bağlantı geçersiz veya süresi dolmuş.');
    }
    return rows[0].user_id;
  }
}
