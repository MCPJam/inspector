const keyFor = (serverName: string) =>
  `mcpjam:conformance:timeout:${serverName}`;

function readTimeout(read: () => string | null): number | undefined {
  try {
    const raw = read();
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

export function readLocalTimeout(serverName: string): number | undefined {
  return readTimeout(() => window.localStorage.getItem(keyFor(serverName)));
}

const sessionKeyFor = (projectId: string, serverName: string) =>
  `mcpjam:conformance:session-timeout:${JSON.stringify([projectId, serverName])}`;

/** Unsaved project servers keep their timeout across route remounts in this tab. */
export function readSessionTimeout(
  projectId: string,
  serverName: string,
): number | undefined {
  return readTimeout(() =>
    window.sessionStorage.getItem(sessionKeyFor(projectId, serverName)),
  );
}

export function saveSessionTimeout(
  projectId: string,
  serverName: string,
  seconds: number | null,
): void {
  const key = sessionKeyFor(projectId, serverName);
  if (seconds === null) window.sessionStorage.removeItem(key);
  else window.sessionStorage.setItem(key, String(seconds));
}

export function saveLocalTimeout(
  serverName: string,
  seconds: number | null,
): void {
  if (seconds === null) window.localStorage.removeItem(keyFor(serverName));
  else window.localStorage.setItem(keyFor(serverName), String(seconds));
}
