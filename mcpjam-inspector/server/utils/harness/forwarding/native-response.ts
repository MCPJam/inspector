import type { Settlement } from "./execution-control.js";
import { NativeWireError, nativeResponseHeaders } from "./native-wire.js";
const MAX_BODY = 32 * 1024 * 1024;
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_EVIDENCE = 7.5 * 1024 * 1024;

function outcome(raw: string, id: string | number): Settlement | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("jsonrpc" in value) ||
    value.jsonrpc !== "2.0" ||
    !("id" in value) ||
    value.id !== id ||
    "method" in value
  )
    return undefined;
  if (Buffer.byteLength(raw) > MAX_EVIDENCE)
    return { outcome: "incomplete", truncated: true };
  if ("error" in value) return { outcome: "protocol_error", resultJson: raw };
  if (!("result" in value)) return undefined;
  const result = value.result;
  const kind =
    result &&
    typeof result === "object" &&
    "isError" in result &&
    result.isError === true
      ? "tool_error"
      : result &&
          typeof result === "object" &&
          "status" in result &&
          result.status === "input_required"
        ? "input_required"
        : "success";
  return { outcome: kind, resultJson: raw };
}

function frameEnd(text: string): number | undefined {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n" && text[i] !== "\r") continue;
    const end = i + (text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1);
    if (i === start) return end;
    start = end;
    i = end - 1;
  }
  return undefined;
}

async function cancelFailedReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  error: unknown,
) {
  try {
    await reader.cancel(error);
  } catch {
    /* A failed stream rejects cancel too; retain its original error and still settle evidence. */
  }
}

/** Preserve each validated SSE frame, and settle the matching result before releasing it. */
export async function nativeResponse(args: {
  response: Response;
  id?: string | number;
  settle?: (result: Settlement) => Promise<void>;
  subscription?: boolean;
}): Promise<Response> {
  const { response, id, settle } = args;
  const headers = nativeResponseHeaders(response.headers);
  if (!response.body) {
    if (settle) await settle({ outcome: "incomplete" });
    return new Response(null, { status: response.status, headers });
  }
  const media = response.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (media !== "text/event-stream") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY) throw new NativeWireError("response_too_large");
        chunks.push(chunk.value);
      }
      if (id === undefined && response.status === 202 && bytes === 0)
        return new Response(null, { status: response.status, headers });
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("jsonrpc" in parsed) ||
        parsed.jsonrpc !== "2.0"
      ) {
        const safe = JSON.stringify({
          jsonrpc: "2.0",
          id: id ?? null,
          error: {
            code: -32000,
            message: `MCP server returned HTTP ${response.status} without an MCP response.`,
          },
        });
        if (settle)
          await settle({ outcome: "protocol_error", resultJson: safe });
        headers.set("content-type", "application/json");
        return new Response(safe, {
          status: response.status >= 400 ? response.status : 502,
          headers,
        });
      }
      if (settle && id !== undefined)
        await settle(outcome(raw, id) ?? { outcome: "incomplete" });
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        headers,
      });
    } catch (error) {
      await cancelFailedReader(reader, error);
      if (settle) await settle({ outcome: "incomplete" });
      throw error;
    }
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let bytes = 0;
  let complete = false;
  let ended = false;
  async function finishIncomplete() {
    if (settle && !complete) await settle({ outcome: "incomplete" });
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const end = frameEnd(pending);
          if (end !== undefined) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end);
            if (Buffer.byteLength(frame) > MAX_FRAME)
              throw new NativeWireError("frame_too_large");
            const data = frame
              .split(/\r\n|\r|\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (data) {
              let message: unknown;
              try {
                message = JSON.parse(data);
              } catch {
                throw new NativeWireError("non_mcp_stream");
              }
              if (
                !message ||
                typeof message !== "object" ||
                !("jsonrpc" in message) ||
                message.jsonrpc !== "2.0"
              )
                throw new NativeWireError("non_mcp_stream");
              if (id !== undefined && settle) {
                const result = outcome(data, id);
                if (result) {
                  await settle(result);
                  complete = true;
                }
              }
            }
            controller.enqueue(encoder.encode(frame));
            return;
          }
          if (Buffer.byteLength(pending) > MAX_FRAME)
            throw new NativeWireError("frame_too_large");
          if (ended) {
            if (pending.trim()) throw new NativeWireError("truncated_stream");
            await finishIncomplete();
            controller.close();
            return;
          }
          const chunk = await reader.read();
          if (chunk.done) {
            pending += decoder.decode();
            ended = true;
            continue;
          }
          bytes += chunk.value.byteLength;
          if (!args.subscription && bytes > MAX_BODY)
            throw new NativeWireError("response_too_large");
          pending += decoder.decode(chunk.value, { stream: true });
        }
      } catch (error) {
        await cancelFailedReader(reader, error);
        try {
          await finishIncomplete();
        } catch (settlementError) {
          controller.error(settlementError);
          return;
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finishIncomplete();
      }
    },
  });
  return new Response(stream, { status: response.status, headers });
}
