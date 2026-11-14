import type { Context } from "hono";
import {
  decodePluginFileMetadata,
  encodePluginFileMetadata,
  PLUGIN_FILE_MAX_BYTES,
  PLUGIN_FILE_MEDIA_TYPE,
} from "../../../shared/plugin-file-transfer.js";
import { PLUGIN_FILE_METADATA_HEADER } from "../../../shared/plugin-file-headers.js";
import {
  ResourceGrantError,
  type ResourceGrantService,
} from "./resource-grants.js";

export async function readFileWriteBody(c: Context): Promise<unknown> {
  if (c.req.header("content-type") !== PLUGIN_FILE_MEDIA_TYPE)
    return c.req.json();
  let metadata: Record<string, unknown>;
  try {
    metadata = decodePluginFileMetadata(
      c.req.header(PLUGIN_FILE_METADATA_HEADER) ?? null,
    );
  } catch {
    throw new ResourceGrantError("RESOURCE_INVALID");
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > PLUGIN_FILE_MAX_BYTES)
    throw new ResourceGrantError("RESOURCE_TOO_LARGE");
  const params = metadata.params;
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    "text" in params ||
    "blob" in params
  )
    throw new ResourceGrantError("RESOURCE_INVALID");
  return {
    ...metadata,
    params: { ...params, blob: Buffer.from(bytes).toString("base64") },
  };
}

export function fileReadResponse(
  c: Context,
  result: Awaited<ReturnType<ResourceGrantService["read"]>>,
  diagnostics: unknown[],
) {
  if (c.req.header("accept") !== PLUGIN_FILE_MEDIA_TYPE)
    return c.json({ ...result, diagnostics });
  const content = result.contents[0];
  const blob = "blob" in content ? content.blob : undefined;
  const text = "text" in content ? content.text : undefined;
  const bytes =
    typeof blob === "string"
      ? Buffer.from(blob, "base64")
      : Buffer.from(text ?? "", "utf8");
  if (bytes.byteLength > PLUGIN_FILE_MAX_BYTES)
    throw new ResourceGrantError("RESOURCE_TOO_LARGE");
  const metadata = {
    uri: content.uri,
    ...(content.mimeType ? { mimeType: content.mimeType } : {}),
    _meta: content._meta,
  };
  try {
    c.header(
      PLUGIN_FILE_METADATA_HEADER,
      encodePluginFileMetadata({
        content: metadata,
        byteLength: bytes.byteLength,
        representation: typeof blob === "string" ? "blob" : "text",
        diagnostics,
      }),
    );
  } catch {
    throw new ResourceGrantError("RESOURCE_INVALID");
  }
  c.header("Content-Type", PLUGIN_FILE_MEDIA_TYPE);
  return c.body(new Uint8Array(bytes));
}
