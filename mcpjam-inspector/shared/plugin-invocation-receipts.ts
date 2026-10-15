/** Private, Inspector-authored invocation receipt policy and data.
 * Framework independent; the Convex mirror is pinned in its mirror manifest.
 * A receipt never supplies current authorization or original instance lifetime.
 */
export const INVOCATION_RECEIPT_PATH = "/internal/v1/plugin-invocations";
export const INVOCATION_RECEIPT_TTL_MS = 30 * 60 * 1000;
export const INVOCATION_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const INVOCATION_RECEIPT_VALUE_BYTES = 256 * 1024;
export const INVOCATION_RECEIPT_TOTAL_BYTES = 768 * 1024;
export const INVOCATION_RECEIPT_RESPONSE_BYTES = 1024 * 1024;
export const INVOCATION_RECEIPT_HTTP_BYTES =
  INVOCATION_RECEIPT_VALUE_BYTES * 2 + 8192;
export const INVOCATION_RECEIPT_MAX_ROUNDS = 64;
export interface DurableInvocationLeg {
  round: number;
  fingerprint: string;
  state:
    | "reserved"
    | "dispatched"
    | "completed"
    | "suspended"
    | "failed"
    | "unknown"
    | "unavailable";
  valueJson?: string;
  errorCode?: string;
  continuationId?: string;
  pendingRound?: number;
}
export interface DurableInvocationReceipt {
  fingerprint: string;
  revision: string;
  expiresAt: number;
  legs: DurableInvocationLeg[];
}

/** Original root-view control. Private parent/child recovery is separate. */
export const PLUGIN_INSTANCE_CONTROL_PATH =
  "/internal/v1/plugin-instance-controls";
export const PLUGIN_INSTANCE_CONTROL_BYTES = 128 * 1024;
export const PLUGIN_INSTANCE_CONTEXT_BYTES = 384 * 1024;
export const PLUGIN_INSTANCE_CONTROL_HTTP_BYTES = 1024 * 1024 + 8192;
export interface DurablePluginInstanceControl {
  snapshotJson: string;
  expiresAt: number;
  /** Present only when original context ownership was issued with this control. */
  contextVersion?: number;
  contextJson?: string;
  /** Private settings projection. Never part of model context discovery. */
  settingsVersion?: number;
  settingsJson?: string;
}

/** Private original read-only file target. This descriptor is data, never a
 * resource grant, provider session, browser path selector or effect receipt. */
export interface DurableRunFileDescriptor {
  key: string;
  name: string;
  privatePath: string;
  maxBytes: number;
}
const hasFileControlCharacter = (value: string) => {
  for (const character of value) {
    if (character.charCodeAt(0) < 32) return true;
  }
  return false;
};
export function isDurableRunFileDescriptor(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  const fields = ["key", "name", "privatePath", "maxBytes"];
  return (
    Object.keys(file).length === fields.length &&
    Object.keys(file).every((key) => fields.includes(key)) &&
    typeof file.key === "string" &&
    file.key.length > 0 &&
    file.key.length <= 128 &&
    typeof file.name === "string" &&
    !!file.name.trim() &&
    new TextEncoder().encode(file.name).byteLength <= 255 &&
    !/[/\\]/u.test(file.name) &&
    !hasFileControlCharacter(file.name) &&
    ![".", ".."].includes(file.name) &&
    typeof file.privatePath === "string" &&
    file.privatePath.startsWith("/") &&
    file.privatePath.length <= 4096 &&
    !hasFileControlCharacter(file.privatePath) &&
    Number.isSafeInteger(file.maxBytes) &&
    (file.maxBytes as number) >= 0 &&
    (file.maxBytes as number) <= 1024 * 1024
  );
}

/** Private host-selected bytes. Only an Inspector service control can bind this
 * descriptor to an original instance; the cleanup journal alone grants nothing. */
export interface DurableInteractiveFileDescriptor {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  relativePath: string;
  resourceId: string;
  ownership: {
    version: 1;
    name: string;
    identity: { dev: string; ino: string };
    createdAt: number;
    expiresAt: number;
    bindingDigest: string;
    bytes: number;
  };
}
export function isDurableInteractiveFileDescriptor(
  value: unknown,
): value is DurableInteractiveFileDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as DurableInteractiveFileDescriptor;
  const exact = (value: object, fields: string[]) =>
    Object.keys(value).sort().join() === [...fields].sort().join();
  const digest = (value: unknown) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const record = file.ownership;
  return (
    exact(file, [
      "name",
      "mimeType",
      "size",
      "sha256",
      "relativePath",
      "resourceId",
      "ownership",
    ]) &&
    typeof file.name === "string" &&
    !!file.name.trim() &&
    new TextEncoder().encode(file.name).byteLength <= 255 &&
    !/[/\\]/u.test(file.name) &&
    !hasFileControlCharacter(file.name) &&
    ![".", ".."].includes(file.name) &&
    typeof file.mimeType === "string" &&
    file.mimeType.length <= 128 &&
    !hasFileControlCharacter(file.mimeType) &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0 &&
    file.size <= 256 * 1024 &&
    digest(file.sha256) &&
    digest(file.resourceId) &&
    typeof file.relativePath === "string" &&
    /^[a-f0-9-]{36}\//.test(file.relativePath) &&
    file.relativePath.split("/").length === 2 &&
    file.relativePath.split("/")[1] === file.name &&
    !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    exact(record, [
      "version",
      "name",
      "identity",
      "createdAt",
      "expiresAt",
      "bindingDigest",
      "bytes",
    ]) &&
    record.version === 1 &&
    record.name === `mcpjam-form-${record.bindingDigest}` &&
    digest(record.bindingDigest) &&
    !!record.identity &&
    typeof record.identity === "object" &&
    !Array.isArray(record.identity) &&
    exact(record.identity, ["dev", "ino"]) &&
    typeof record.identity.dev === "string" &&
    typeof record.identity.ino === "string" &&
    /^[0-9]{1,32}$/.test(record.identity.dev) &&
    /^[0-9]{1,32}$/.test(record.identity.ino) &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt > 0 &&
    record.expiresAt === record.createdAt + 30 * 60_000 &&
    record.bytes === file.size
  );
}

/** Private placement references, separate from execution/approval receipts. */
export const PLUGIN_FORM_FILE_CONTROL_PATH = "/internal/v1/plugin-form-files";
export const PLUGIN_FORM_FILE_CONTROL_BYTES = 32 * 1024;
export const PLUGIN_FORM_FILE_CONTROL_HTTP_BYTES = 1024 * 1024;
export const PLUGIN_FORM_FILE_CONTROL_LIMIT = 16;
export interface DurablePluginFormFileControl {
  controlHash: string;
  state: "placed" | "retained" | "closed";
  expiresAt: number;
  snapshotJson?: string;
}

/** A saved catalog reference, never an upload ownership record or filesystem grant.
 * Consumers must revalidate the current saved server and operator target policy. */
export interface DurableSavedResourceDescriptor {
  kind: "saved-resource";
  version: 1;
  uri: string;
  name: string;
  sourceName?: string;
  localTarget?: {
    root: string;
    relativePath: string;
    uri: string;
    exclusiveWrites: true;
  };
}
export function isDurableSavedResourceDescriptor(
  value: unknown,
): value is DurableSavedResourceDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as DurableSavedResourceDescriptor;
  const text = (s: unknown) =>
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 4096 &&
    !hasFileControlCharacter(s);
  if (
    Object.keys(file).some(
      (key) =>
        ![
          "kind",
          "version",
          "uri",
          "name",
          "sourceName",
          "localTarget",
        ].includes(key),
    ) ||
    file.kind !== "saved-resource" ||
    file.version !== 1 ||
    !text(file.uri) ||
    !text(file.name) ||
    (file.sourceName !== undefined && !text(file.sourceName))
  )
    return false;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(file.uri)) return false;
  const target = file.localTarget;
  if (target === undefined) return true;
  return (
    !!target &&
    typeof target === "object" &&
    !Array.isArray(target) &&
    Object.keys(target).sort().join() ===
      "exclusiveWrites,relativePath,root,uri" &&
    text(target.root) &&
    target.root.startsWith("/") &&
    !target.root.split("/").some((part) => part === "." || part === "..") &&
    text(target.relativePath) &&
    !target.relativePath.includes("\\") &&
    !target.relativePath
      .split("/")
      .some((part) => !part || part === "." || part === "..") &&
    target.uri === file.uri &&
    target.exclusiveWrites === true
  );
}
