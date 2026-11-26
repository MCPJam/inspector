import { z } from "zod";

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const ListenRequest = z.object({
  id: z.union([z.string(), z.number()]),
  params: z.object({ notifications: z.object({ eventsListChanged: z.boolean().optional() }) }),
});

/** The server SDK's core subscription filter would strip the Events field. */
export function createCatalogFixture(acknowledge: () => boolean) {
  let replacement: string | undefined;
  const streams = new Map<string | number, ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const frame = (id: string | number, method: string, params: object = {}) =>
    encoder.encode(`data: ${JSON.stringify({
      jsonrpc: "2.0", method, params: { ...params, _meta: { [SUBSCRIPTION_ID]: id } },
    })}\n\n`);

  return {
    get replacement() { return replacement; },
    openStreams: () => streams.size,
    change(name: string, matchingSubscription = true) {
      replacement = name;
      for (const [id, output] of streams) {
        output.enqueue(frame(matchingSubscription ? id : "another-listen", "notifications/events/list_changed"));
      }
    },
    async listen(request: Request, record: (params: unknown) => void): Promise<Response> {
      const { id, params } = ListenRequest.parse(await request.json());
      record(params);
      const agreed = params.notifications.eventsListChanged && acknowledge();
      let onAbort: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(output) {
          streams.set(id, output);
          onAbort = () => {
            streams.delete(id);
            output.close();
          };
          if (request.signal.aborted) {
            onAbort();
            return;
          }
          request.signal.addEventListener("abort", onAbort, { once: true });
          output.enqueue(frame(id, "notifications/subscriptions/acknowledged", {
            notifications: agreed ? { eventsListChanged: true } : {},
          }));
        },
        cancel() {
          streams.delete(id);
          if (onAbort) request.signal.removeEventListener("abort", onAbort);
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
  };
}
