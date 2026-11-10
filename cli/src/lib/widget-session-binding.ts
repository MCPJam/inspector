import { readFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { getAuthFilePath } from "./auth-store.js";
import { writeFileAtomic } from "./atomic-write.js";
import { buildPlatformClient } from "./platform-client.js";
import { resolvePlatformCredential } from "./platform-auth.js";
import { normalizeInspectorBaseUrl } from "./inspector-api.js";
import type { InspectorProjectTarget } from "./inspector-project-target.js";
import { usageError } from "./output.js";

interface Binding {
  inspectorUrl: string;
  apiUrl: string;
  projectId: string;
  serverId: string;
}
const file = (id: string) => {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return undefined;
  return path.join(
    path.dirname(getAuthFilePath()),
    "widget-sessions",
    `${id}.json`,
  );
};
export function savedWidgetPath(
  target: Pick<Binding, "projectId" | "serverId">,
) {
  return `/api/v1/projects/${encodeURIComponent(target.projectId)}/servers/${encodeURIComponent(target.serverId)}`;
}
export function requireLocalWidgetEndpoint(baseUrl?: string) {
  const base = normalizeInspectorBaseUrl(baseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname))
    throw usageError(
      "Saved-server widget sessions require a local Inspector URL.",
    );
  return base;
}
export async function rememberWidgetSession(
  id: string,
  baseUrl: string | undefined,
  target: InspectorProjectTarget,
) {
  const filename = file(id);
  if (!filename) throw usageError("Inspector returned an invalid session ID.");
  const inspectorUrl = requireLocalWidgetEndpoint(baseUrl);
  const binding: Binding = {
    inspectorUrl,
    apiUrl: target.apiUrl ?? `${inspectorUrl}/api/v1`,
    projectId: target.projectId,
    serverId: target.serverId,
  };
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFileAtomic(filename, JSON.stringify(binding), { mode: 0o600 });
}
export async function forgetWidgetSession(id: string) {
  const filename = file(id);
  if (filename)
    await unlink(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
}
export async function resolveWidgetSessionBinding(options: {
  sessionId: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  const filename = file(options.sessionId);
  if (!filename) return undefined;
  let text: string;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object")
    throw usageError("Widget session binding is invalid. Start a new session.");
  const record = value as Record<string, unknown>;
  const { inspectorUrl, apiUrl, projectId, serverId } = record;
  if (
    typeof inspectorUrl !== "string" ||
    !inspectorUrl ||
    typeof apiUrl !== "string" ||
    !apiUrl ||
    typeof projectId !== "string" ||
    !projectId ||
    typeof serverId !== "string" ||
    !serverId
  )
    throw usageError("Widget session binding is invalid. Start a new session.");
  const binding: Binding = { inspectorUrl, apiUrl, projectId, serverId };
  if (
    options.baseUrl &&
    normalizeInspectorBaseUrl(options.baseUrl) !== binding.inspectorUrl
  )
    throw usageError(
      "This widget session belongs to a different Inspector URL.",
    );
  requireLocalWidgetEndpoint(binding.inspectorUrl);
  // Resolve deployment guards before reading or sending the current credential.
  buildPlatformClient({ apiUrl: binding.apiUrl, apiKey: options.apiKey });
  const token = await resolvePlatformCredential({
    apiUrl: binding.apiUrl,
    apiKey: options.apiKey,
  }).getAuth();
  return {
    baseUrl: binding.inspectorUrl,
    route: `${savedWidgetPath(binding)}/widget-sessions/${encodeURIComponent(options.sessionId)}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}
