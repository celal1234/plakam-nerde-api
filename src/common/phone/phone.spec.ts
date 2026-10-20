import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone';

describe('normalizePhone', () => {
  it.each([
    ['+90 532 123 45 67', '+905321234567'],
    ['0532 123 4567', '+905321234567'],
    ['5321234567', '+905321234567'],
    ['(0532) 123-45-67', '+905321234567'],
    ['00905321234567', '+905321234567'],
    ['905321234567', '+905321234567'],
    ['0212 555 12 34', '+902125551234'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', '123', '+49 151 12345678', '0632 123 4567', '0532 123 456', '0532 123 45678', '05321234567x'])('%s reddedilir', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});
