// ISO 6346 container number validation (e.g. "TGHU5303645").

const LETTER_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  let v = 10;
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (v % 11 === 0) v++; // skip multiples of 11
    map[ch] = v++;
  }
  return map;
})();

export function checkDigit(first10: string): number | null {
  if (!/^[A-Z]{4}\d{6}$/.test(first10)) return null;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i];
    const val = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    sum += val * 2 ** i;
  }
  return (sum % 11) % 10;
}

export function isValidContainerNumber(raw: string): boolean {
  const n = normalizeContainerNumber(raw);
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(n)) return false;
  return checkDigit(n.slice(0, 10)) === Number(n[10]);
}

export function normalizeContainerNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

/** Find candidate container numbers in free text (valid or not). */
export function findContainerNumbers(text: string): string[] {
  const out: string[] = [];
  const re = /\b([A-Z]{3}[UJZ])\s?(\d{6,8})\b/gi;
  for (const m of text.matchAll(re)) out.push(normalizeContainerNumber(m[1] + m[2]));
  return out;
}
