import { randomBytes } from 'crypto';

const PUBLIC_ID_BYTES = 8;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// 8 random bytes -> 11 base64url chars (no padding): 64 bits of entropy.
export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}

export function isPublicIdFormat(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_ID_PATTERN.test(value);
}
