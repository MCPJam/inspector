import { getSessionToken } from "@/lib/session-token";
import type { MrtrKeyAnswer, MrtrRound } from "@/shared/local-mrtr";
import {
  LOCAL_MRTR_MAX_FRAME_BYTES,
  LOCAL_MRTR_PROTOCOL,
  localMrtrMessageSchema,
  localMrtrProtocols,
  type LocalMrtrEvent,
} from "@/shared/local-mrtr-wire";

const RETRY_MS = 1500;
const ANSWER_ACK_MS = 30_000;
const UNKNOWN_ANSWER =
  "The form connection was interrupted. Check the form and try again.";

export interface LocalMrtrStream {
  respond(
    opId: string,
    roundKey: string,
    responses: Record<string, MrtrKeyAnswer>,
  ): Promise<void>;
  close(): void;
}

export function openLocalMrtrStream(options: {
  onEvent: (event: LocalMrtrEvent) => void;
  onSnapshot: (rounds: MrtrRound[]) => void;
  token?: () => string;
  baseUrl?: string;
  socket?: (url: string, protocols: string[]) => WebSocket;
}): LocalMrtrStream {
  const url = new URL(
    "/api/web/mcp/mrtr/stream",
    options.baseUrl ?? window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const create = options.socket ?? ((u, p) => new WebSocket(u, p));
  const token = options.token ?? getSessionToken;
  const pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let snapshot: MrtrRound[] | null = null;
  let sequence = 0;
  let snapshotReady = false;

  const rejectPending = () => {
    for (const value of pending.values()) {
      clearTimeout(value.timer);
      value.reject(new Error(UNKNOWN_ANSWER));
    }
    pending.clear();
  };
  const schedule = () => {
    if (!stopped && retry === undefined) {
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, RETRY_MS);
    }
  };
  const connect = () => {
    if (stopped) return;
    const credential = token();
    if (!credential) {
      schedule();
      return;
    }
    let next: WebSocket;
    try {
      next = create(url.toString(), localMrtrProtocols(credential));
    } catch {
      // A transient constructor/handshake failure is retried without replaying answers.
      schedule();
      return;
    }
    socket = next;
    next.onopen = () => {
      if (next.protocol !== LOCAL_MRTR_PROTOCOL)
        next.close(1002, "The form could not be read. Reload the page to reconnect.");
    };
    next.onmessage = (event) => {
      if (socket !== next || typeof event.data !== "string") return;
      if (
        new TextEncoder().encode(event.data).byteLength >
        LOCAL_MRTR_MAX_FRAME_BYTES
      ) {
        next.close(1009, "The form message is too large. Reload the page to reconnect.");
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        next.close(1007, "The form could not be read. Reload the page to reconnect.");
        return;
      }
      const parsed = localMrtrMessageSchema.safeParse(raw);
      if (!parsed.success) {
        next.close(1007, "The form could not be read. Reload the page to reconnect.");
        return;
      }
      const message = parsed.data;
      if (message.type === "snapshot_start") {
        snapshotReady = false;
        snapshot = [];
        return;
      }
      if (message.type === "snapshot_end") {
        if (snapshot !== null) {
          options.onSnapshot(snapshot);
          snapshotReady = true;
        }
        snapshot = null;
        return;
      }
      if (message.type === "keepalive") return;
      if (message.type === "response") {
        const reply = pending.get(message.requestId);
        if (!reply) return;
        pending.delete(message.requestId);
        clearTimeout(reply.timer);
        if (message.result.ok) reply.resolve();
        else
          reply.reject(
            new Error(
              "Your form answer was not accepted. Reopen the form and submit it again.",
            ),
          );
        return;
      }
      if (snapshot !== null) {
        snapshot = snapshot.filter((round) => round.opId !== message.opId);
        if (message.type === "mrtr_input_request") snapshot.push(message);
      } else options.onEvent(message);
    };
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      snapshotReady = false;
      snapshot = null;
      rejectPending();
      schedule();
    };
  };
  connect();

  return {
    respond(opId, roundKey, responses) {
      if (!socket || socket.readyState !== WebSocket.OPEN || !snapshotReady) {
        return Promise.reject(new Error(UNKNOWN_ANSWER));
      }
      const active = socket;
      const requestId = String(++sequence);
      const encoded = JSON.stringify({
        type: "respond",
        requestId,
        opId,
        roundKey,
        responses,
      });
      if (
        new TextEncoder().encode(encoded).byteLength >
        LOCAL_MRTR_MAX_FRAME_BYTES
      ) {
        return Promise.reject(
          new Error(
            "The form answer exceeds the 30 MiB local limit. Reduce its content and try again.",
          ),
        );
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(UNKNOWN_ANSWER));
        }, ANSWER_ACK_MS);
        pending.set(requestId, { resolve, reject, timer });
        try {
          active.send(encoded);
        } catch {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(new Error(UNKNOWN_ANSWER));
        }
      });
    },
    close() {
      stopped = true;
      clearTimeout(retry);
      retry = undefined;
      const active = socket;
      socket = null;
      snapshotReady = false;
      snapshot = null;
      active?.close();
      rejectPending();
    },
  };
}
