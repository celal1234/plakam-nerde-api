import { describe, expect, it } from 'vitest';
import { normalizePlate } from './plate';

describe('normalizePlate', () => {
  it.each([
    ['34 abc 123', '34ABC123', true],
    ['34-AA-1234', '34AA1234', true],
    ['06 a 12', '06A12', true],
    ['35 ıst 01', '35IST01', true],
    ['81 Z 9999', '81Z9999', true],
  ])('%s → %s (formatOk=%s)', (input, normalized, formatOk) => {
    expect(normalizePlate(input)).toEqual({ normalized, formatOk });
  });

  it.each(['00 ABC 123', '82 ABC 123', '34 ÇAB 123', '34 ABCD 12', '34 AB 1', '34 AB 12345'])(
    '%s formata uymuyor ama yine de normalize ediliyor',
    (input) => {
      expect(normalizePlate(input).formatOk).toBe(false);
    },
  );
});
