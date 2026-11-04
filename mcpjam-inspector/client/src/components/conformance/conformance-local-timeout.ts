const keyFor = (serverName: string) =>
  `mcpjam:conformance:timeout:${serverName}`;

export function readLocalTimeout(serverName: string): number | undefined {
  try {
    const raw = window.localStorage.getItem(keyFor(serverName));
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= 300
      ? value
      : undefined;
  } catch {
    // A blocked storage read falls back to the existing unlimited behavior.
    return undefined;
  }
}

export function saveLocalTimeout(
  serverName: string,
  seconds: number | null,
): void {
  if (seconds === null) window.localStorage.removeItem(keyFor(serverName));
  else window.localStorage.setItem(keyFor(serverName), String(seconds));
}
