// Salted, non-reversible bucketing id for an XAA target, derived from the
// target key (source + registration id or server name). Used as the
// `target_id` analytics dimension so distinct targets can be counted without
// ever sending a server name, URL, or hostname.
const TARGET_ID_SALT = "mcpjam-xaa-target/v1";

export function hashXaaTargetId(targetKey: string): string {
  // FNV-1a 32-bit over salt + key → hex. Not cryptographic, but a stable
  // one-way bucket id is all the distinct-count metric needs.
  const input = `${TARGET_ID_SALT}:${targetKey}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
