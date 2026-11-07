/**
 * UUIDv7 (RFC 9562): 48-bit Unix ms timestamp + random bits. Time-ordered so IDs created offline
 * on different devices sort roughly by creation time and index well in SQLite/PostgreSQL.
 */
let lastMs = -1;
let seq = 0;

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Monotonic within the same millisecond: use a 12-bit counter in rand_a.
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff;
  } else {
    lastMs = now;
    seq = (bytes[6]! << 8 | bytes[7]!) & 0x7ff;
  }

  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
