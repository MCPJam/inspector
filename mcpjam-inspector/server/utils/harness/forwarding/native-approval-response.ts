/** Keep an attended approval alive through HTTP proxies without fabricating MCP progress. */
export async function nativeApprovalResponse(args: {
  rpcId?: string | number | null;
  signal?: AbortSignal;
  run: (waiting: () => void, signal: AbortSignal) => Promise<Response>;
  onError: (error: unknown) => void;
}): Promise<Response> {
  let waiting!: () => void;
  const abort = new AbortController();
  const signal = args.signal
    ? AbortSignal.any([args.signal, abort.signal])
    : abort.signal;
  const pending = new Promise<null>((resolve) => {
    waiting = () => resolve(null);
  });
  const finished = args.run(waiting, signal).then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
  const first = await Promise.race([pending, finished]);
  if (first !== null) {
    if ("error" in first) throw first.error;
    return first.response;
  }
  const encoder = new TextEncoder();
  let cancelled = false;
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const heartbeat = () => {
        if (!cancelled)
          controller.enqueue(encoder.encode(": awaiting approval\n\n"));
      };
      heartbeat();
      const timer = setInterval(heartbeat, 10_000);
      const pump = async () => {
        try {
          const result = await finished;
          clearInterval(timer);
          if (cancelled) {
            if ("response" in result) await result.response.body?.cancel();
            return;
          }
          if ("error" in result) throw result.error;
          const response = result.response;
          if (
            response.headers
              .get("content-type")
              ?.includes("text/event-stream") &&
            response.body
          ) {
            const reader = response.body.getReader();
            upstreamReader = reader;
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (cancelled) {
                await reader.cancel();
                return;
              }
              controller.enqueue(chunk.value);
            }
          } else {
            const raw = await response.text();
            if (!cancelled)
              controller.enqueue(
                encoder.encode(
                  raw
                    .split(/\r?\n/)
                    .map((line) => `data: ${line}`)
                    .join("\n") + "\n\n",
                ),
              );
          }
        } catch (error) {
          if (cancelled) return;
          args.onError(error);
          if (!cancelled)
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ jsonrpc: "2.0", id: args.rpcId ?? null, error: { code: -32000, message: "The forwarded MCP request could not complete." } })}\n\n`,
              ),
            );
        } finally {
          clearInterval(timer);
          if (!cancelled) controller.close();
        }
      };
      void pump();
    },
    async cancel() {
      cancelled = true;
      abort.abort(new Error("Native approval response closed."));
      await upstreamReader?.cancel();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}
