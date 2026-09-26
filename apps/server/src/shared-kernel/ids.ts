/**
 * UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then random bits.
 * Time-ordered ids keep B-tree inserts local and sort naturally for cursor pagination.
 * Ids are generated here, in application code, so entities have identity before they
 * are saved (useful for idempotency keys, events and outbox payloads).
 */
export function newId(atMs: number = Date.now()): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const ts = BigInt(Math.max(0, Math.floor(atMs)));
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

/** Milliseconds encoded in a UUIDv7, or null for other versions. */
export function timestampOf(id: string): number | null {
  if (!isUuid(id) || id[14] !== '7') return null;
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
