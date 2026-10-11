/** Bounded downloads, including lifecycle-checked artifact ranges. Never forwards auth. */
export const ARTIFACT_RANGE_BYTES = 8 * 1024 * 1024;

export class ArtifactDownloadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ArtifactDownloadError";
  }
}

type DownloadOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxBytes: number;
};
type Segment = { start: number; end: number; total: number };

function rangeOf(
  response: Response,
  start: number,
  maxBytes: number,
  total?: number,
): Segment {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get("content-range") ?? "",
  );
  if (!match)
    throw new ArtifactDownloadError(
      "Artifact range metadata is missing or invalid",
    );
  const [, from, to, size] = match;
  const range = { start: Number(from), end: Number(to), total: Number(size) };
  if (
    ![range.start, range.end, range.total].every(Number.isSafeInteger) ||
    range.start !== start ||
    range.end < start ||
    range.end >= range.total ||
    range.end - start + 1 > ARTIFACT_RANGE_BYTES ||
    range.total > maxBytes ||
    (total !== undefined && range.total !== total)
  ) {
    throw new ArtifactDownloadError(
      "Artifact range does not match the requested bounded download",
    );
  }
  const length = declaredLength(response);
  if (length !== null && length !== range.end - range.start + 1) {
    throw new ArtifactDownloadError("Artifact range length is inconsistent");
  }
  return range;
}

function declaredLength(response: Response): number | null {
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") return null;
  const value = response.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ArtifactDownloadError("Artifact length is invalid");
  }
  return Number(value);
}

async function request(
  url: URL | string,
  options: DownloadOptions,
  start?: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      redirect: "error",
      signal: options.signal,
      ...(start !== undefined
        ? {
            headers: {
              Range: `bytes=${start}-${start + ARTIFACT_RANGE_BYTES - 1}`,
            },
          }
        : {}),
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new ArtifactDownloadError("Artifact download transport failed");
  }
  if (
    !response.body ||
    (response.status !== 200 && response.status !== 206) ||
    (start !== undefined && response.status !== 206)
  ) {
    await response.body?.cancel();
    throw new ArtifactDownloadError(
      `Artifact download returned ${response.status}`,
      response.status,
    );
  }
  return response;
}

async function* segments(
  url: URL | string,
  options: DownloadOptions,
  first: Response,
  firstRange: Segment | null,
  state: { reader?: ReadableStreamDefaultReader<Uint8Array> },
): AsyncGenerator<Uint8Array> {
  let response = first;
  let range = firstRange;
  let received = 0;
  for (;;) {
    const reader = response.body!.getReader();
    state.reader = reader;
    let segmentBytes = 0;
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        segmentBytes += chunk.value.byteLength;
        received += chunk.value.byteLength;
        if (
          received > options.maxBytes ||
          (range && segmentBytes > range.end - range.start + 1)
        ) {
          throw new ArtifactDownloadError(
            "Artifact body exceeds its bounded size",
          );
        }
        yield chunk.value;
      }
    } catch (error) {
      if (error instanceof ArtifactDownloadError) throw error;
      options.signal?.throwIfAborted();
      throw new ArtifactDownloadError("Artifact body transfer failed");
    } finally {
      // A read error already failed the download; cancellation must not replace
      // its sanitized error with transport diagnostics containing access links.
      try {
        await reader.cancel();
      } catch (error) {
        if (error instanceof ArtifactDownloadError) throw error;
        throw new ArtifactDownloadError("Artifact body transfer failed");
      } finally {
        reader.releaseLock();
        state.reader = undefined;
      }
    }
    const expected = range
      ? range.end - range.start + 1
      : declaredLength(response);
    if (expected !== null && segmentBytes !== expected) {
      throw new ArtifactDownloadError(
        "Artifact body is truncated or does not match its length",
      );
    }
    if (!range || range.end + 1 === range.total) return;
    response = await request(url, options, range.end + 1);
    try {
      range = rangeOf(response, range.end + 1, options.maxBytes, range.total);
      validateEncoding(response);
    } catch (error) {
      await response.body!.cancel();
      throw error;
    }
  }
}

function validateEncoding(response: Response): void {
  const encoding = response.headers.get("content-encoding");
  if (
    response.status === 206 &&
    encoding &&
    encoding.trim().toLowerCase() !== "identity"
  ) {
    throw new ArtifactDownloadError(
      "Artifact transfer encoding must preserve byte ranges",
    );
  }
}

/** Streams the entire object while rechecking lifecycle authorization for each range. */
export async function openArtifactDownload(
  url: URL | string,
  options: DownloadOptions,
): Promise<{
  body: ReadableStream<Uint8Array>;
  length: number | null;
}> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new ArtifactDownloadError("Artifact size limit is invalid");
  }
  const transfer = new AbortController();
  options = {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, transfer.signal])
      : transfer.signal,
  };
  const response = await request(url, options);
  let range: Segment | null;
  let length: number | null;
  try {
    validateEncoding(response);
    range =
      response.status === 206 ? rangeOf(response, 0, options.maxBytes) : null;
    length = range?.total ?? declaredLength(response);
    if (length !== null && length > options.maxBytes) {
      throw new ArtifactDownloadError(
        "Artifact exceeds the download size limit",
      );
    }
  } catch (error) {
    await response.body!.cancel();
    throw error;
  }
  const state: { reader?: ReadableStreamDefaultReader<Uint8Array> } = {};
  const iterator = segments(url, options, response, range, state);
  return {
    length,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await iterator.next();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        transfer.abort();
        await state.reader?.cancel();
        await iterator.return(undefined);
      },
    }),
  };
}

export async function downloadArtifactBytes(
  url: URL | string,
  options: DownloadOptions,
): Promise<Uint8Array> {
  const { body } = await openArtifactDownload(url, options);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
