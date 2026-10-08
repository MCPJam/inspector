import { z } from "zod";
import { pluginFormPreviewSchema } from "./plugin-extensions/form-plan.js";

export const pluginFormParentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("legacy"),
    id: z.string().min(1).max(4096),
    round: z.literal(0),
  }),
  z.strictObject({
    kind: z.literal("mrtr"),
    id: z.string().min(1).max(4096),
    round: z.number().int().positive(),
    inputRequestKey: z.string().min(1).max(4096),
  }),
]);
export type PluginFormParent = z.infer<typeof pluginFormParentSchema>;

export const pluginFormServiceRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(256),
  pluginWorkspace: z.unknown(),
  sourceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  parent: pluginFormParentSchema,
});
export const pluginFormPreviewRequestSchema =
  pluginFormServiceRequestSchema.extend({
    target: pluginFormPreviewSchema,
  });
export const pluginFormFileUploadRequestSchema =
  pluginFormServiceRequestSchema.extend({
    field: z.string().min(1).max(256),
    operationId: z.string().uuid(),
    // Browser-selected hierarchy inside one exclusive host directory, never a destination.
    relativePaths: z
      .array(z.string().min(1).max(1024))
      .min(1)
      .max(16)
      .optional(),
  });
export const PLUGIN_FORM_FILE_MAX_BYTES = 256 * 1024;
export const PLUGIN_FORM_FILE_BATCH_MAX_BYTES = 768 * 1024;
export const PLUGIN_FORM_FILE_MAX_COUNT = 16;
export const pluginFormFileServicesSchema = z.strictObject({
  userResources: z.boolean(),
  userResourceKinds: z
    .array(z.enum(["file", "directory"]))
    .max(2)
    .refine((kinds) => new Set(kinds).size === kinds.length),
  /** Who asked for the form, and the asking client's File resources toggle:
   * a form requested through an MCP App takes uploads only when it is on. */
  origin: z.enum(["server", "mcp-app"]).optional(),
  fileResources: z.boolean().optional(),
});

/** One nonempty browser directory. Empty folders/symlinks are not representable.
 * Reject traversal, portable name aliases and file/directory collisions before I/O. */
export function pluginFormDirectoryPaths(
  files: readonly { name: string; relativePath?: string }[],
) {
  if (!files.length || files.length > PLUGIN_FORM_FILE_MAX_COUNT)
    throw new Error("Invalid directory selection");
  const paths = files.map((file) => {
    const path = file.relativePath;
    if (!path || path.length > 1024) throw new Error("Invalid directory path");
    const parts = path.split("/");
    if (
      parts.length < 2 ||
      parts.length > 12 ||
      parts.at(-1) !== file.name ||
      parts.some(
        (part) =>
          !part.trim() ||
          [".", ".."].includes(part) ||
          /[\\\\\0:]/.test(part) ||
          new TextEncoder().encode(part).byteLength > 255,
      )
    )
      throw new Error("Invalid directory path");
    return parts;
  });
  if (
    new Set(paths.map((parts) => parts[0])).size !== 1 ||
    new TextEncoder().encode(
      JSON.stringify(files.map((file) => file.relativePath)),
    ).byteLength >
      12 * 1024
  )
    throw new Error("Invalid directory hierarchy");
  const aliases = paths.map((parts) =>
    parts.map((part) => part.normalize("NFC").toLowerCase()).join("/"),
  );
  if (
    new Set(aliases).size !== aliases.length ||
    aliases.some((path, index) =>
      aliases.some(
        (other, otherIndex) =>
          index !== otherIndex && other.startsWith(path + "/"),
      ),
    )
  )
    throw new Error("Conflicting directory paths");
  // Directory components with case/Unicode aliases cannot silently merge on macOS.
  const names = new Map<string, string>();
  for (const parts of paths)
    for (let depth = 1; depth <= parts.length; depth++) {
      const path = parts.slice(0, depth).join("/");
      const alias = path.normalize("NFC").toLowerCase();
      if (names.has(alias) && names.get(alias) !== path)
        throw new Error("Conflicting directory names");
      names.set(alias, path);
    }
  return paths;
}
/** Saved operator contract for named processes sharing this host's filesystem.
 * Never derived from a form, URI, stdio transport or browser request. */
export const pluginLocalFormFilesOptInSchema = z.strictObject({
  version: z.literal(1),
  serverIds: z.array(z.string().min(1).max(256)).min(1).max(64),
});
export const pluginFormFileUploadResultSchema = z.strictObject({
  uris: z
    .array(z.string().regex(/^mcpjam-form-file:\/\/[a-f0-9-]{36}$/))
    .min(1)
    .max(PLUGIN_FORM_FILE_MAX_COUNT),
});
// Exact MCP bytes only. HTML/SVG and arbitrary URL navigation have no renderer
// here; nested Apps use their separate admitted child service.
export const PLUGIN_FORM_PREVIEW_MAX_BYTES = 256 * 1024;
const previewUri = z.string().min(1).max(8192);
export function pluginFormPreviewBytes(blob: string): Uint8Array {
  if (
    !blob.length ||
    blob.length > PLUGIN_FORM_PREVIEW_MAX_BYTES ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      blob,
    )
  )
    throw new Error("Invalid preview bytes");
  const binary = atob(blob);
  if (btoa(binary) !== blob) throw new Error("Invalid preview bytes");
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
const previewContentSchema = z.union([
  z.strictObject({
    uri: previewUri,
    mimeType: z.enum(["text/plain", "text/markdown", "application/json"]),
    text: z.string().max(PLUGIN_FORM_PREVIEW_MAX_BYTES),
  }),
  z.strictObject({
    uri: previewUri,
    mimeType: z.enum([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "audio/wav",
      "audio/mpeg",
      "audio/ogg",
      "audio/webm",
      "video/mp4",
      "video/webm",
    ]),
    blob: z
      .string()
      .max(PLUGIN_FORM_PREVIEW_MAX_BYTES)
      .refine((value) => {
        try {
          pluginFormPreviewBytes(value);
          return true;
        } catch {
          return false;
        }
      }),
  }),
]);
export const pluginFormResourcePreviewSchema = z
  .strictObject({
    type: z.literal("resource"),
    contents: z.array(previewContentSchema).min(1).max(16),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      PLUGIN_FORM_PREVIEW_MAX_BYTES,
  );
export type PluginFormResourcePreview = z.infer<
  typeof pluginFormResourcePreviewSchema
>;
