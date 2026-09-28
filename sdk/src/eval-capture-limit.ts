/** Default cap on the SDK's retained evidence for one iteration. Executor allocations are outside this bound. */
export const DEFAULT_MAX_CAPTURED_BYTES = 16 * 1024 * 1024;

export class EvalCaptureLimitError extends Error {
  readonly code = "SDK_CAPTURE_LIMIT_EXCEEDED";
  constructor(readonly maxCapturedBytes: number) {
    super(
      `SDK capture limit exceeded (${maxCapturedBytes} bytes); iteration evidence is unavailable`
    );
    this.name = "EvalCaptureLimitError";
  }
}

/** Count JSON evidence without first allocating an unbounded serialized copy. */
export function assertEvalCaptureWithinLimit(
  value: unknown,
  maxBytes: number
): void {
  let remaining = maxBytes;
  const ancestors = new Set<object>();
  const consume = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) throw new EvalCaptureLimitError(maxBytes);
  };
  const string = (text: string) => {
    consume(2); // JSON quotes
    // Every UTF-16 unit needs at least one output byte. Refuse huge strings before walking them.
    if (text.length > remaining) throw new EvalCaptureLimitError(maxBytes);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code))
        consume(2);
      else if (code < 32) consume(6);
      else if (code < 128) consume(1);
      else if (code < 2048) consume(2);
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        index + 1 < text.length &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff
      ) {
        consume(4);
        index++;
      } else if (code >= 0xd800 && code <= 0xdfff) consume(6);
      else consume(3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (item === null || item === undefined) {
      consume(4);
      return;
    }
    if (typeof item === "string") {
      string(item);
      return;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      consume(JSON.stringify(item).length);
      return;
    }
    if (typeof item !== "object") return;
    // Cycles cannot be serialized; avoid recursive capture exhausting the JS stack.
    if (depth > 128 || ancestors.has(item))
      throw new EvalCaptureLimitError(maxBytes);
    if (item instanceof Date) {
      string(item.toISOString());
      return;
    }
    ancestors.add(item);
    consume(2);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (index) consume(1);
        visit(item[index], depth + 1);
      }
    } else {
      let count = 0;
      for (const key of Object.keys(item)) {
        const child = (item as Record<string, unknown>)[key];
        if (
          child === undefined ||
          typeof child === "function" ||
          typeof child === "symbol"
        )
          continue;
        if (count++) consume(1);
        string(key);
        consume(1);
        visit(child, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}
