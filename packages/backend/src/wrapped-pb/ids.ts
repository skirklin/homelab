/**
 * Client-supplied PocketBase record IDs.
 *
 * PB accepts a `[a-z0-9]{15}` `id` field on create. Generating IDs locally
 * lets optimistic creates use the same id the server will confirm, so the
 * live subscription event merges by id with no temp-ID remap.
 *
 * Collision odds at our scale are negligible (36^15 ≈ 2.2×10^23).
 */

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 15; i++) out += CHARS[bytes[i] % 36];
  return out;
}
