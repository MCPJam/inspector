import { SavedRequest } from "./types/request-types";

const STORAGE_PREFIX = "mcp-inspector.saved-requests";

function getKey(serverKey: string): string {
  return `${STORAGE_PREFIX}:${serverKey}`;
}

export function listSavedRequests(serverKey: string): SavedRequest[] {
  try {
    const raw = localStorage.getItem(getKey(serverKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedRequest[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRequest(
  serverKey: string,
  request: Omit<
    SavedRequest,
    "id" | "createdAt" | "updatedAt" | "serverKey"
  > & { id?: string },
): SavedRequest {
  const now = new Date().toISOString();
  const existing = listSavedRequests(serverKey);
  let final: SavedRequest;
  if (request.id) {
    final = {
      id: request.id,
      title: request.title,
      description: request.description,
      toolName: request.toolName,
      parameters: request.parameters,
      isFavorite: request.isFavorite,
      serverKey,
      createdAt: existing.find((r) => r.id === request.id)?.createdAt || now,
      updatedAt: now,
    };
    const idx = existing.findIndex((r) => r.id === final.id);
    if (idx >= 0) existing[idx] = final;
    else existing.push(final);
  } else {
    final = {
      id: crypto.randomUUID(),
      title: request.title,
      description: request.description,
      toolName: request.toolName,
      parameters: request.parameters,
      isFavorite: request.isFavorite,
      serverKey,
      createdAt: now,
      updatedAt: now,
    };
    existing.unshift(final);
  }
  localStorage.setItem(getKey(serverKey), JSON.stringify(existing));
  return final;
}

export function deleteRequest(serverKey: string, id: string): void {
  const existing = listSavedRequests(serverKey).filter((r) => r.id !== id);
  localStorage.setItem(getKey(serverKey), JSON.stringify(existing));
}

export function getRequest(
  serverKey: string,
  id: string,
): SavedRequest | undefined {
  return listSavedRequests(serverKey).find((r) => r.id === id);
}

export function duplicateRequest(
  serverKey: string,
  id: string,
): SavedRequest | undefined {
  const req = getRequest(serverKey, id);
  if (!req) return undefined;
  return saveRequest(serverKey, {
    title: `${req.title} (copy)`,
    description: req.description,
    toolName: req.toolName,
    parameters: req.parameters,
    isFavorite: req.isFavorite,
  });
}

export function renameRequest(
  serverKey: string,
  id: string,
  title: string,
): SavedRequest | undefined {
  const existing = getRequest(serverKey, id);
  if (!existing) return undefined;
  return saveRequest(serverKey, {
    id,
    title,
    description: existing.description,
    toolName: existing.toolName,
    parameters: existing.parameters,
    isFavorite: existing.isFavorite,
  });
}

export function toggleFavorite(
  serverKey: string,
  id: string,
): SavedRequest | undefined {
  const existing = getRequest(serverKey, id);
  if (!existing) return undefined;
  return saveRequest(serverKey, {
    id,
    title: existing.title,
    description: existing.description,
    toolName: existing.toolName,
    parameters: existing.parameters,
    isFavorite: !existing.isFavorite,
  });
}

export function updateRequestMeta(
  serverKey: string,
  id: string,
  updates: Partial<Pick<SavedRequest, "title" | "description" | "isFavorite">>,
): SavedRequest | undefined {
  const existing = getRequest(serverKey, id);
  if (!existing) return undefined;
  return saveRequest(serverKey, {
    id,
    title: updates.title ?? existing.title,
    description: updates.description ?? existing.description,
    toolName: existing.toolName,
    parameters: existing.parameters,
    isFavorite: updates.isFavorite ?? existing.isFavorite,
  });
}
