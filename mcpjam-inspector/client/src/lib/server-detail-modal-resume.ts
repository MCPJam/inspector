export interface ServerDetailModalStateMarker {
  serverName: string;
}

interface ServerDetailModalResumeMarker extends ServerDetailModalStateMarker {
  createdAt: number;
}

const SERVER_DETAIL_MODAL_OPEN_STORAGE_KEY = "mcp-server-detail-modal-open";
const SERVER_DETAIL_MODAL_OAUTH_RESUME_STORAGE_KEY =
  "mcp-server-detail-modal-oauth-resume";
const SERVER_DETAIL_MODAL_OAUTH_RESUME_TTL_MS = 10 * 60 * 1000;

function isServerDetailModalStateMarker(
  value: unknown,
): value is ServerDetailModalStateMarker {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { serverName?: unknown }).serverName === "string"
  );
}

function isServerDetailModalResumeMarker(
  value: unknown,
): value is ServerDetailModalResumeMarker {
  return (
    isServerDetailModalStateMarker(value) &&
    typeof (value as { createdAt?: unknown }).createdAt === "number"
  );
}

function readJsonStorage<T>(
  storageKey: string,
  isValid: (value: unknown) => value is T,
): T | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!isValid(parsed)) {
      localStorage.removeItem(storageKey);
      return null;
    }

    return parsed;
  } catch {
    localStorage.removeItem(storageKey);
    return null;
  }
}

export function writeOpenServerDetailModalState(serverName: string): void {
  localStorage.setItem(
    SERVER_DETAIL_MODAL_OPEN_STORAGE_KEY,
    JSON.stringify({ serverName }),
  );
}

export function clearOpenServerDetailModalState(): void {
  localStorage.removeItem(SERVER_DETAIL_MODAL_OPEN_STORAGE_KEY);
}

export function readOpenServerDetailModalState(): ServerDetailModalStateMarker | null {
  return readJsonStorage(
    SERVER_DETAIL_MODAL_OPEN_STORAGE_KEY,
    isServerDetailModalStateMarker,
  );
}

export function captureServerDetailModalOAuthResume(serverName: string): void {
  const openModalState = readOpenServerDetailModalState();
  if (!openModalState || openModalState.serverName !== serverName) {
    return;
  }

  localStorage.setItem(
    SERVER_DETAIL_MODAL_OAUTH_RESUME_STORAGE_KEY,
    JSON.stringify({
      serverName,
      createdAt: Date.now(),
    } satisfies ServerDetailModalResumeMarker),
  );
}

export function readServerDetailModalOAuthResume(): ServerDetailModalStateMarker | null {
  const marker = readJsonStorage(
    SERVER_DETAIL_MODAL_OAUTH_RESUME_STORAGE_KEY,
    isServerDetailModalResumeMarker,
  );

  if (!marker) {
    return null;
  }

  if (Date.now() - marker.createdAt > SERVER_DETAIL_MODAL_OAUTH_RESUME_TTL_MS) {
    clearServerDetailModalOAuthResume();
    return null;
  }

  return { serverName: marker.serverName };
}

export function clearServerDetailModalOAuthResume(): void {
  localStorage.removeItem(SERVER_DETAIL_MODAL_OAUTH_RESUME_STORAGE_KEY);
}
