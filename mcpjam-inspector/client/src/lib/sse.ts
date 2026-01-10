import { SSEvent } from "@/shared/sse";

// Parses a ReadableStream of text/event-stream and yields parsed SSE events.
export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SSEvent | "[DONE]"> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep last partial

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          yield "[DONE]";
          return;
        }
        try {
          const evt = JSON.parse(data) as SSEvent;
          yield evt;
        } catch {
          // ignore parse errors for malformed lines
          continue;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {}
  }
}
