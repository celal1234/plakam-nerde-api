// Pilot yalnız Türkiye (K1): +90 ve 10 hane; alan kodu 2–5 ile başlar (sabit hat 2/3/4, cep 5).
// Kabul edilen yazımlar: "+90 532 123 45 67", "0532 123 4567", "5321234567", "(0532) 123-45-67".
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  if (digits.startsWith('+90')) digits = digits.slice(3);
  else if (digits.startsWith('0090')) digits = digits.slice(4);
  else if (digits.startsWith('90') && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[2-5]\d{9}$/.test(digits)) return null;
  return `+90${digits}`;
}
