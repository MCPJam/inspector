/** The bare server key is a compatibility alias; identity is always connectionId. */
export function connectionKey(
  serverKey: string,
  connectionId: string,
  isDefault = false
): string {
  return isDefault ? serverKey : `${serverKey}#${connectionId}`;
}
export function parseConnectionKey(key: string): {
  serverKey: string;
  connectionId?: string;
} {
  const hash = key.lastIndexOf("#");
  const suffix = key.slice(hash + 1);
  return hash >= 0 && /^[a-z0-9]{32}$/.test(suffix)
    ? { serverKey: key.slice(0, hash), connectionId: suffix }
    : { serverKey: key };
}
