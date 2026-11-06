// Observe only the benchmark chat response. Preserve the original response and
// bound metadata collection; model text and tool arguments are never retained.
export async function installBrowserTrace(page) {
  await page.evaluate(() => {
    const original = globalThis.fetch,
      trace = { events: [] };
    globalThis.__warmBrowserTrace = trace;
    globalThis.fetch = async function (...args) {
      const input = args[0],
        url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
      const isChat =
        new URL(url, location.href).pathname === "/api/web/chat-v2";
      const started = performance.now(),
        response = await original.apply(this, args);
      if (isChat) {
        trace.headersAt = performance.timeOrigin + performance.now();
        trace.requestStartedAt = performance.timeOrigin + started;
        trace.requestId = response.headers.get("x-request-id");
        const reader = response.clone().body?.getReader();
        if (reader)
          trace.read = (async () => {
            const decoder = new TextDecoder();
            let text = "",
              size = 0,
              complete = false;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                  complete = true;
                  break;
                }
                size += value.byteLength;
                if (size > 262144) {
                  await reader.cancel();
                  break;
                }
                text += decoder.decode(value, { stream: true });
                let end;
                while ((end = text.indexOf("\n")) >= 0) {
                  const line = text.slice(0, end);
                  text = text.slice(end + 1);
                  if (!line.startsWith("data: ") || line.includes("[DONE]"))
                    continue;
                  let event;
                  try {
                    event = JSON.parse(line.slice(6));
                  } catch {
                    continue;
                  }
                  const phase =
                    event.type === "data-harness-startup"
                      ? event.data?.phase
                      : undefined;
                  const kind =
                    phase ??
                    (["text-delta", "tool-input-start", "finish"].includes(
                      event.type,
                    )
                      ? event.type
                      : undefined);
                  if (kind && !trace.events.some((e) => e.kind === kind))
                    trace.events.push({
                      kind,
                      at: performance.timeOrigin + performance.now(),
                    });
                }
              }
            } catch (error) {
              trace.readError = error.name;
            } finally {
              reader.releaseLock();
              if (complete) globalThis.__warmAgentClock?.ended?.();
            }
          })();
      }
      return response;
    };
    trace.restore = () => {
      globalThis.fetch = original;
    };
  });
}
export async function browserTrace(page) {
  return page.evaluate(() => {
    const trace = globalThis.__warmBrowserTrace;
    return trace
      ? {
          requestId: trace.requestId,
          requestStartedAt: trace.requestStartedAt,
          headersAt: trace.headersAt,
          events: trace.events,
        }
      : null;
  });
}
export async function restoreBrowserTrace(page) {
  await page.evaluate(() => globalThis.__warmBrowserTrace?.restore());
}
