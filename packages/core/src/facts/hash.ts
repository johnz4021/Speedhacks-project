// Small, fast, deterministic string hash (two FNV-1a variants → 16 hex chars). Browser-safe.

export function hashText(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Collapse whitespace runs so formatting-only edits keep the same hash. */
export const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
