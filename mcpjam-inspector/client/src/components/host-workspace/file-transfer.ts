import { authFetch } from "@/lib/session-token";
import { pluginFileWriteParamsSchema } from "@/shared/plugin-file";
import {
  PluginFileTransferError,
  decodePluginFileMetadata,
  encodePluginFileMetadata,
  PLUGIN_FILE_MAX_BYTES,
  PLUGIN_FILE_MEDIA_TYPE,
  pluginFileBytesToBase64,
  readPluginFileBody,
} from "@/shared/plugin-file-transfer";
import { PLUGIN_FILE_METADATA_HEADER } from "@/shared/plugin-file-headers";

export async function readTransferredFile(
  response: Response,
  signal: AbortSignal,
) {
  const metadata = decodePluginFileMetadata(
    response.headers.get(PLUGIN_FILE_METADATA_HEADER),
  );
  const content = metadata.content;
  if (
    !content ||
    typeof content !== "object" ||
    Array.isArray(content) ||
    !["text", "blob"].includes(String(metadata.representation)) ||
    typeof metadata.byteLength !== "number"
  )
    throw new PluginFileTransferError("RESOURCE_INVALID");
  const bytes = await readPluginFileBody(response, signal, metadata.byteLength);
  return {
    contents: [
      {
        ...content,
        ...(metadata.representation === "text"
          ? { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
          : { blob: pluginFileBytesToBase64(bytes) }),
      },
    ],
    diagnostics: metadata.diagnostics,
  };
}

export async function writeTransferredFile(
  owner: Record<string, unknown>,
  params: unknown,
  signal: AbortSignal,
) {
  const parsed = pluginFileWriteParamsSchema.parse(params);
  const { text, blob, ...metadata } = parsed;
  if (
    blob !== undefined &&
    blob.length > Math.ceil(PLUGIN_FILE_MAX_BYTES / 3) * 4
  )
    throw new PluginFileTransferError("RESOURCE_TOO_LARGE");
  const bytes =
    text !== undefined
      ? new TextEncoder().encode(text)
      : Uint8Array.from(atob(blob!), (char) => char.charCodeAt(0));
  if (bytes.byteLength > PLUGIN_FILE_MAX_BYTES)
    throw new PluginFileTransferError("RESOURCE_TOO_LARGE");
  const init = {
    method: "POST",
    headers: {
      "Content-Type": PLUGIN_FILE_MEDIA_TYPE,
      [PLUGIN_FILE_METADATA_HEADER]: encodePluginFileMetadata({
        ...owner,
        params: metadata,
      }),
    },
    body: bytes.buffer,
    signal,
  };
  try {
    return await authFetch("/api/web/apps/plugin-instances/files/write", init);
  } catch {
    signal.throwIfAborted();
    return authFetch("/api/web/apps/plugin-instances/files/write", init);
  }
}
