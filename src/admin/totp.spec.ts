import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateSecret, hotp, verifyTotp } from './totp';

// RFC 6238 Ek B test vektörleri (SHA-1, anahtar "12345678901234567890").
const RFC_KEY = Buffer.from('12345678901234567890');

describe('totp', () => {
  it('RFC 6238 vektörlerini üretir', () => {
    expect(hotp(RFC_KEY, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(RFC_KEY, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(RFC_KEY, Math.floor(20000000000 / 30), 8)).toBe('65353130');
  });

  it('base32 gidiş-dönüş', () => {
    const buf = Buffer.from('hello world, plakam nerde?');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    expect(base32Encode(RFC_KEY)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('komşu adımları kabul eder, uzaktakileri reddeder', () => {
    const secret = generateSecret();
    const now = 1_760_000_000_000;
    const step = Math.floor(now / 30000);
    const key = base32Decode(secret);
    expect(verifyTotp(secret, hotp(key, step), now)).toBe(step);
    expect(verifyTotp(secret, hotp(key, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(key, step + 2), now)).toBeNull();
    expect(verifyTotp(secret, 'abc123', now)).toBeNull();
  });
});
