import { Buffer } from "node:buffer";

const MAX_PENDING = 16;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 4 * MAX_FRAME_BYTES;
const INPUT_TIMEOUT_MS = 5 * 60_000;
const STREAM_ATTACH_TIMEOUT_MS = 5_000;
const key = (id) => `${typeof id}:${id}`;
const validId = (id) =>
  typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
const failure = (id, message) => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32000, message },
});

export function isJsonRpcResponse(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.jsonrpc === "2.0" &&
    validId(value.id) &&
    !("method" in value) &&
    "result" in value !== "error" in value &&
    (!("error" in value) ||
      (typeof value.error?.code === "number" &&
        typeof value.error.message === "string"))
  );
}

/** A form wait suspends only its known parent, with an absolute lifetime cap. */
export function requestDeadline(onTimeout, timeoutMs) {
  let remaining = timeoutMs;
  let started = Date.now();
  let timer = setTimeout(onTimeout, remaining);
  let holds = 0;
  let stopped = false;
  const hard = setTimeout(onTimeout, Math.min(2_147_483_647, timeoutMs + INPUT_TIMEOUT_MS));
  timer.unref();
  hard.unref();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(hard);
    },
    pause() {
      if (stopped) return () => {};
      if (holds++ === 0) {
        remaining = Math.max(1, remaining - (Date.now() - started));
        clearTimeout(timer);
      }
      let released = false;
      return () => {
        if (released || stopped) return;
        released = true;
        if (--holds === 0) {
          started = Date.now();
          timer = setTimeout(onTimeout, remaining);
          timer.unref();
        }
      };
    },
  };
}

/** No event IDs or replay: a lost stream fails its pending child requests. */
export function createServerRequestRelay({
  send,
  beginInput,
  timeoutMs = INPUT_TIMEOUT_MS,
}) {
  const pending = new Map();
  let bytes = 0;
  let stream;
  let heartbeat;
  let connected = false;
  let closed = false;
  const finish = (entry, response) => {
    if (!pending.delete(key(entry.id))) return;
    bytes -= entry.bytes;
    clearTimeout(entry.timer);
    entry.parent.signal.removeEventListener("abort", entry.cancel);
    entry.parent.release();
    send(response);
  };
  const disconnect = () => {
    clearInterval(heartbeat);
    const previous = stream;
    stream = undefined;
    for (const entry of [...pending.values()])
      finish(entry, failure(entry.id, "The host input stream closed."));
    previous?.end();
  };
  const write = (frame) => {
    if (!stream) return false;
    stream.write(`event: message\ndata: ${frame}\n\n`);
    if (stream.writableLength <= MAX_PENDING_BYTES) return true;
    disconnect();
    return false;
  };
  const arm = (entry, duration) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() =>
      finish(entry, failure(entry.id, "The host input request timed out.")), duration);
    entry.timer.unref();
  };
  return {
    open(req, res) {
      if (!req.headers.accept?.includes("text/event-stream")) {
        res.writeHead(406);
        res.end();
        return;
      }
      if (closed || stream) {
        res.writeHead(409);
        res.end();
        return;
      }
      // Last-Event-ID would imply replay, which could repeat a user interaction.
      if (req.headers["last-event-id"] !== undefined) {
        res.writeHead(409);
        res.end();
        return;
      }
      connected = true;
      stream = res;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.flushHeaders();
      heartbeat = setInterval(() => {
        if (!stream) return;
        stream.write(": keepalive\n\n");
        if (stream.writableLength > MAX_PENDING_BYTES) disconnect();
      }, 15_000);
      heartbeat.unref();
      res.on("error", () => { if (stream === res) disconnect(); });
      res.on("close", () => {
        if (stream === res) disconnect();
      });
      for (const entry of pending.values()) {
        arm(entry, Math.min(timeoutMs, INPUT_TIMEOUT_MS));
        if (!write(entry.frame)) break;
      }
    },
    receive(message) {
      const hasId = "id" in message;
      if (
        message.jsonrpc !== "2.0" ||
        typeof message.method !== "string" ||
        (hasId && !validId(message.id))
      )
        return;
      const frame = JSON.stringify(message);
      const size = Buffer.byteLength(frame);
      if (!hasId) {
        if (size <= MAX_FRAME_BYTES) write(frame);
        return;
      }
      const duplicate = pending.get(key(message.id));
      if (duplicate) {
        finish(duplicate, failure(message.id, "Duplicate host input request."));
        return;
      }
      if (
        closed ||
        (!stream && connected) ||
        pending.size >= MAX_PENDING ||
        size > MAX_FRAME_BYTES ||
        bytes + size > MAX_PENDING_BYTES
      ) {
        send(failure(message.id, "The host input request is unavailable."));
        return;
      }
      const parent = beginInput();
      if (!parent || parent.signal.aborted) {
        send(failure(message.id, "Host input requires one active request."));
        return;
      }
      const entry = {
        id: message.id,
        frame,
        bytes: size,
        parent,
        timer: undefined,
        cancel: undefined,
      };
      entry.cancel = () =>
        finish(entry, failure(entry.id, "The parent request ended."));
      // Allow asynchronous GET setup, without giving a streamless client the
      // full interactive wait. The parent deadline still has its hard cap.
      arm(entry, Math.min(timeoutMs, stream ? INPUT_TIMEOUT_MS : STREAM_ATTACH_TIMEOUT_MS));
      bytes += size;
      pending.set(key(entry.id), entry);
      parent.signal.addEventListener("abort", entry.cancel, { once: true });
      if (stream) write(frame);
    },
    respond(message) {
      if (
        !isJsonRpcResponse(message) ||
        Buffer.byteLength(JSON.stringify(message)) > MAX_FRAME_BYTES
      )
        return false;
      const entry = pending.get(key(message.id));
      if (!entry) return false;
      finish(entry, message);
      return true;
    },
    close() {
      closed = true;
      disconnect();
    },
  };
}
