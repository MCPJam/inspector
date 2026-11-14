import type { MiddlewareHandler } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import {
  LOCAL_MRTR_MAX_FRAME_BYTES,
  localMrtrCredential,
  localMrtrResponseSchema,
  type LocalMrtrMessage,
} from "@/shared/local-mrtr-wire.js";
import { isAllowedRequestOrigin } from "../../middleware/origin-validation.js";
import { validateToken } from "../../services/session-token.js";
import { logger } from "../../utils/logger.js";
import { subscribeLocalMrtrEvents, submitMrtrResponses } from "../mcp/mrtr.js";

/** Local session-authenticated forms; the hosted bearer routes never mount this. */
export function createLocalMrtrStream(
  upgradeWebSocket: UpgradeWebSocket<
    unknown,
    { onError: (error: unknown) => void }
  >,
): { handler: MiddlewareHandler; kill: () => void; shutdown: () => void } {
  const sockets = new Map<WSContext<unknown>, () => void>();
  let generation = 0;
  let shuttingDown = false;
  const kill = () => {
    generation++;
    for (const [socket, cleanup] of sockets) {
      cleanup();
      socket.close(1012, "The inspector is restarting.");
    }
    sockets.clear();
  };
  const handler: MiddlewareHandler = async (c, next) => {
    const token = localMrtrCredential(c.req.header("sec-websocket-protocol"));
    if (
      !isAllowedRequestOrigin(c.req.header("origin")) ||
      !token ||
      !validateToken(token)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (shuttingDown)
      return c.json({ error: "The inspector is restarting." }, 503);
    const openedGeneration = generation;
    return upgradeWebSocket(() => {
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      let openedSocket: WSContext<unknown> | undefined;
      const cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = undefined;
        if (openedSocket) sockets.delete(openedSocket);
      };
      const send = (socket: WSContext<unknown>, message: LocalMrtrMessage) => {
        if (closed) return;
        if (!validateToken(token)) {
          cleanup();
          socket.close(4401, "The form session expired.");
          return;
        }
        try {
          socket.send(JSON.stringify(message));
        } catch {
          cleanup();
          if (socket.readyState < 2)
            socket.close(1011, "Form stream disconnected.");
        }
      };
      return {
        onOpen(_event, socket) {
          openedSocket = socket;
          if (
            shuttingDown ||
            openedGeneration !== generation ||
            !validateToken(token)
          ) {
            cleanup();
            socket.close(4401, "The form session expired.");
            return;
          }
          sockets.set(socket, cleanup);
          unsubscribe = subscribeLocalMrtrEvents(
            { send: (event) => send(socket, event), close: cleanup },
            (rounds) => {
              send(socket, { type: "snapshot_start" });
              for (const round of rounds) send(socket, round);
              send(socket, { type: "snapshot_end" });
            },
          );
          if (closed) {
            unsubscribe();
            unsubscribe = undefined;
            return;
          }
          heartbeat = setInterval(
            () => send(socket, { type: "keepalive" }),
            25_000,
          );
        },
        onMessage(event, socket) {
          if (closed) return;
          if (!validateToken(token)) {
            cleanup();
            socket.close(4401, "The form session expired.");
            return;
          }
          if (
            typeof event.data !== "string" ||
            Buffer.byteLength(event.data, "utf8") > LOCAL_MRTR_MAX_FRAME_BYTES
          ) {
            cleanup();
            socket.close(1009, "The form answer is too large.");
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(event.data);
          } catch {
            cleanup();
            socket.close(1007, "Invalid form answer.");
            return;
          }
          const parsed = localMrtrResponseSchema.safeParse(raw);
          if (!parsed.success) {
            cleanup();
            socket.close(1008, "Invalid form answer.");
            return;
          }
          try {
            const result = submitMrtrResponses(
              parsed.data.opId,
              parsed.data.responses,
              parsed.data.roundKey,
            );
            send(socket, {
              type: "response",
              requestId: parsed.data.requestId,
              result,
            });
          } catch {
            logger.warn("[local-mrtr] Could not process a form answer.");
            cleanup();
            socket.close(1011, "The form answer could not be processed.");
          }
        },
        onClose: cleanup,
        onError() {
          cleanup();
          logger.debug("[local-mrtr] Form stream disconnected.");
        },
      };
    })(c, next);
  };
  return {
    handler,
    kill,
    shutdown() {
      shuttingDown = true;
      kill();
    },
  };
}
