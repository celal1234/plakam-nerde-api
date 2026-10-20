import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ApiError } from '../errors/api-error';

const IV_BYTES = 12;
const TAG_BYTES = 16;

// Telefon ve MFA sırrı gibi alanlar için AES-256-GCM (T6 §5). Çıktı: iv | etiket | şifreli metin.
// Anahtar DATA_ENCRYPTION_KEY'den gelir; değişirse eski kayıtlar çözülemez.
@Injectable()
export class DataCipher {
  private readonly key?: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('DATA_ENCRYPTION_KEY');
    this.key = raw ? Buffer.from(raw, 'base64') : undefined;
  }

  encrypt(plain: string): Buffer {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(data: Buffer): string {
    const key = this.requireKey();
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'ENCRYPTION_UNAVAILABLE', 'Şifreleme anahtarı tanımlı değil.');
    }
    return this.key;
  }
}
