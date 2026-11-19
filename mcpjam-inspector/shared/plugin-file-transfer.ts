import { z } from "zod";
import { waitForPluginOperation } from "./plugin-operation.js";

export class PluginFileTransferError extends Error {
  constructor(readonly code: "RESOURCE_INVALID" | "RESOURCE_TOO_LARGE") {
    super(code);
    this.name = "PluginFileTransferError";
  }
}

export const PLUGIN_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const PLUGIN_FILE_METADATA_MAX_BYTES = 16 * 1024;
export const PLUGIN_FILE_MEDIA_TYPE = "application/octet-stream";

export function encodePluginFileMetadata(value: Record<string, unknown>) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  if (encoded.length > PLUGIN_FILE_METADATA_MAX_BYTES)
    throw new PluginFileTransferError("RESOURCE_INVALID");
  return encoded;
}

export function decodePluginFileMetadata(value: string | null) {
  if (!value || value.length > PLUGIN_FILE_METADATA_MAX_BYTES)
    throw new PluginFileTransferError("RESOURCE_INVALID");
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(decodeURIComponent(value)));
}

/** Read incrementally so a missing or false Content-Length cannot defeat the limit. */
export async function readPluginFileBody(
  response: Response,
  signal: AbortSignal,
  expectedByteLength?: number,
) {
  const reader = response.body?.getReader();
  if (!reader) {
    if (expectedByteLength !== undefined && expectedByteLength !== 0)
      throw new PluginFileTransferError("RESOURCE_INVALID");
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  let failed = false;
  let failure: unknown;
  try {
    if (
      expectedByteLength !== undefined &&
      (!Number.isSafeInteger(expectedByteLength) ||
        expectedByteLength < 0 ||
        expectedByteLength > PLUGIN_FILE_MAX_BYTES)
    )
      throw new PluginFileTransferError("RESOURCE_INVALID");
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await waitForPluginOperation(signal, () =>
        reader.read(),
      );
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > PLUGIN_FILE_MAX_BYTES)
        throw new PluginFileTransferError("RESOURCE_TOO_LARGE");
      chunks.push(value);
    }
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await waitForPluginOperation(AbortSignal.timeout(1000), () =>
        reader.cancel(),
      );
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
      // Keep both failures: cancellation must not replace the read's diagnosis.
      const combined = new AggregateError(
        [failure, cleanupError],
        failure instanceof Error ? failure.message : "File read failed",
      );
      if (failure instanceof PluginFileTransferError)
        Object.assign(combined, { code: failure.code });
      throw combined;
    } finally {
      reader.releaseLock();
    }
  }
  if (expectedByteLength !== undefined && length !== expectedByteLength)
    throw new PluginFileTransferError("RESOURCE_INVALID");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function pluginFileBytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** Avoid a repeated capture group: multi-megabyte base64 can exhaust RegExp's stack. */
export function isPluginFileBase64(value: string) {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
