/**
 * The hosted validate projection's widening for the server canvas (MJ-001).
 *
 * `projectHostedValidateInitInfo` reports recognized capabilities and a
 * bounded identity, and drops extension settings, experimental entries and
 * icons. With `server-canvas` on, the canvas needs to know WHICH extensions
 * and experimental features a server declared, and its icons. This adds
 * exactly that, built field by field from validated values like the rest of
 * the projection:
 *
 *  - each `extensions` and `experimental` id (a bounded identifier), with its
 *    settings as bounded JSON: depth 4, 16 entries per array, 32 keys per
 *    object, and at most 2 KB serialized per id, past which the id is kept
 *    with `{}`. Keys, booleans, null and finite numbers are kept; a string is
 *    kept only as one token of at most 128 characters (letters, digits and
 *    the punctuation of ids, mime types and URLs, no whitespace), so no free
 *    text comes back;
 *  - `serverInfo.icons` as `{ src, mimeType, sizes }`, where `src` is an
 *    http(s) URL without credentials and the rest are tokens.
 *
 * Nothing else from the upstream answer is added. Pure and mode-agnostic.
 */
import { isPlainRecord, parseHttpUrl } from "./hosted-upstream-projection.js";

const MAX_IDS = 32;
const MAX_ENTRY_BYTES = 2048;
const MAX_DEPTH = 4;
const MAX_OBJECT_KEYS = 32;
const MAX_ARRAY_ITEMS = 16;
const MAX_ICONS = 8;
const MAX_ICON_SIZES = 8;

/** An extension or experimental id: `io.modelcontextprotocol/ui` and kin. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:/@+-]{0,127}$/;
/** A settings key inside a bounded value. */
const KEY_PATTERN = /^[A-Za-z0-9_$.:/@+-]{1,64}$/;
/**
 * A settings string: one token such as `text/html;profile=mcp-app`,
 * `2025-11-25` or `https://example.com/app?x=1`. Anything with whitespace or
 * other characters, or longer, is dropped.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~:/?#@&+,;=%-]{1,128}$/;
const MIME_TYPE_PATTERN = /^image\/[A-Za-z0-9.+-]{1,64}$/;
const ICON_SIZE_PATTERN = /^(?:any|\d{1,5}x\d{1,5})$/;

function boundValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return TOKEN_PATTERN.test(value) ? value : undefined;
  }
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => boundValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!isPlainRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    // `__proto__` passes the key pattern but would set the prototype.
    if (!KEY_PATTERN.test(key) || key === "__proto__") continue;
    const bounded = boundValue(entry, depth + 1);
    if (bounded !== undefined) out[key] = bounded;
  }
  return out;
}

/** One id's settings: bounded, and `{}` when still over the byte cap. */
function boundEntry(value: unknown): Record<string, unknown> {
  const bounded = boundValue(value, 1);
  if (!isPlainRecord(bounded)) return {};
  return Buffer.byteLength(JSON.stringify(bounded), "utf8") <= MAX_ENTRY_BYTES
    ? bounded
    : {};
}

/** Declared ids under `extensions` or `experimental`, with bounded values. */
export function projectDeclaredIds(
  value: unknown,
): Record<string, Record<string, unknown>> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_IDS) break;
    if (ID_PATTERN.test(id)) out[id] = boundEntry(entry);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export type ProjectedIcon = { src: string; mimeType?: string; sizes?: string[] };

/** `serverInfo.icons` as `{ src, mimeType, sizes }`, validated. */
export function projectIcons(value: unknown): ProjectedIcon[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const icons: ProjectedIcon[] = [];
  for (const icon of value) {
    if (icons.length >= MAX_ICONS) break;
    if (!isPlainRecord(icon)) continue;
    const src = parseHttpUrl(icon.src);
    if (!src) continue;
    const mimeType =
      typeof icon.mimeType === "string" && MIME_TYPE_PATTERN.test(icon.mimeType)
        ? icon.mimeType
        : undefined;
    const sizes = Array.isArray(icon.sizes)
      ? icon.sizes
          .filter(
            (size): size is string =>
              typeof size === "string" && ICON_SIZE_PATTERN.test(size),
          )
          .slice(0, MAX_ICON_SIZES)
      : [];
    icons.push({
      src,
      ...(mimeType ? { mimeType } : {}),
      ...(sizes.length > 0 ? { sizes } : {}),
    });
  }
  return icons.length > 0 ? icons : undefined;
}

/**
 * Adds declared extension and experimental ids and server icons to an init
 * info already projected by `projectHostedValidateInitInfo`.
 *
 * `rawCapabilities` is the handshake's capabilities as sent, when the client
 * manager observed them; otherwise the parsed `serverCapabilities` of the
 * unprojected init info is read.
 */
export function widenHostedInitInfoForCanvas(
  projected: Record<string, unknown> | null,
  initInfo: unknown,
  rawCapabilities?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!projected || !isPlainRecord(initInfo)) return projected;
  const capabilities = rawCapabilities ?? initInfo.serverCapabilities;
  const declared = isPlainRecord(capabilities) ? capabilities : {};
  const extensions = projectDeclaredIds(declared.extensions);
  const experimental = projectDeclaredIds(declared.experimental);
  const icons = isPlainRecord(initInfo.serverVersion)
    ? projectIcons(initInfo.serverVersion.icons)
    : undefined;
  const serverCapabilities = isPlainRecord(projected.serverCapabilities)
    ? projected.serverCapabilities
    : {};
  return {
    ...projected,
    ...(extensions || experimental
      ? {
          serverCapabilities: {
            ...serverCapabilities,
            ...(extensions ? { extensions } : {}),
            ...(experimental ? { experimental } : {}),
          },
        }
      : {}),
    ...(icons && isPlainRecord(projected.serverVersion)
      ? { serverVersion: { ...projected.serverVersion, icons } }
      : {}),
  };
}
