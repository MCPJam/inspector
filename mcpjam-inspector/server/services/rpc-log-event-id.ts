/**
 * The identity every traffic-log event carries to the browser.
 *
 * ONE id per PHYSICAL published event — never per method, never per JSON-RPC
 * id. The browser's traffic-log store keys rows on it, so anything that can
 * hand the same event over twice becomes idempotent, while two genuinely
 * distinct frames that merely look alike (a retry, each round of a multi-round
 * MRTR flow) still get a row each.
 *
 * Both delivery paths mint from here rather than each rolling its own scheme:
 *  - local mode: `RpcLogBus.publish` stamps every event, because the Logs SSE
 *    seeds each new connection from the replay buffer (`?replay=N`) and any
 *    re-subscribe therefore re-delivers the tail;
 *  - hosted mode: `HostedRpcLogCollector` stamps every event it buffers,
 *    because a collector can deliver the same event over the `data-rpc-log` /
 *    `data-http-log` stream AND again in the response envelope — a stream
 *    write that fails mid-turn drops the writer and falls back to envelope
 *    delivery, which carries the ALREADY-STREAMED events too.
 *
 * The nonce is per PROCESS, so ids never repeat across a restart (a
 * reconnecting browser must not mistake a brand-new frame for one it already
 * rendered) and two hosted instances serving the same session cannot collide.
 */
const EVENT_ID_NONCE = Math.random().toString(36).slice(2, 10);
let eventIdCounter = 0;

export function nextRpcLogEventId(): string {
  eventIdCounter += 1;
  return `rpc:${EVENT_ID_NONCE}:${eventIdCounter}`;
}
