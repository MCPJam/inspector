import { createHash } from "node:crypto";
import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import {
  ResourceGrantError,
  type BoundResourceAdapter,
} from "./resource-grants.js";

/** Observe late completions while allowing abort to release the caller promptly. */
function waitForRead<T>(
  pending: PromiseLike<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let aborted = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      aborted = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(pending).then(
      (value) => {
        if (settled) {
          if (aborted) onLateValue?.(value);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function cancelLateStream(stream: ReadableStream<Uint8Array> | null) {
  // Cleanup must not wait for a provider that ignores cancellation.
  try {
    void stream?.cancel().catch(() => {});
  } catch {
    // A failed provider cleanup must not expose its private path or credentials.
  }
}

/**
 * Host-only binding for one file in an ALREADY authorized execution session.
 * The session retains its existing root/permission checks; the grant service
 * revalidates live owner/target access before and after each operation.
 * No target provisioning, personal Computer fallback, writes, or watches.
 */
export function createReadOnlyResourceAdapter(options: {
  session: Pick<HarnessV1NetworkSandboxSession, "readFile">;
  key: string;
  privatePath: string;
  maxBytes: number;
  mimeType?: string;
}): BoundResourceAdapter {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw new Error("Invalid resource byte limit");
  if (!options.key || !options.privatePath)
    throw new Error("Invalid resource binding");
  const { key, privatePath, maxBytes, mimeType } = options;
  const readFile = options.session.readFile.bind(options.session);
  return {
    async read(requestedKey, signal) {
      signal.throwIfAborted();
      if (requestedKey !== key) throw new ResourceGrantError("RESOURCE_DENIED");
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let complete = false;
      try {
        const stream = await waitForRead(
          readFile({ path: privatePath, abortSignal: signal }),
          signal,
          cancelLateStream,
        );
        if (stream === null) throw new ResourceGrantError("RESOURCE_DENIED");
        reader = stream.getReader();
        signal.throwIfAborted();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const next = await waitForRead(reader.read(), signal);
          signal.throwIfAborted();
          if (next.done) {
            complete = true;
            break;
          }
          if (!(next.value instanceof Uint8Array))
            throw new ResourceGrantError("RESOURCE_INVALID");
          if (next.value.byteLength > maxBytes - size)
            throw new ResourceGrantError("RESOURCE_TOO_LARGE");
          // Buffer.slice() shares storage, so explicitly own each accepted chunk.
          if (next.value.byteLength) chunks.push(Uint8Array.from(next.value));
          size += next.value.byteLength;
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return {
          bytes,
          etag: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          ...(mimeType ? { mimeType } : {}),
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof ResourceGrantError) throw error;
        throw new ResourceGrantError("RESOURCE_INVALID");
      } finally {
        if (reader) {
          if (!complete) {
            try {
              void reader.cancel().catch(() => {});
            } catch {
              // Cancellation is best-effort; the caller has already been fenced.
            }
          }
          reader.releaseLock();
        }
      }
    },
  };
}
