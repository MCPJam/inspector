/**
 * `webContents.debugger` as a `CdpLike`.
 *
 * Shared by the Electron browser engine and WebMCP inspection. Both use
 * main-process-owned contents through the same CDP adapter.
 *
 * WHY IT LIVES OUTSIDE `daemon/`. Everything under `daemon/**` is bundled and
 * uploaded to an E2B box, where `electron` does not exist and must never be
 * resolved. This directory is the Electron half of the engine and is
 * deliberately kept out of that entry graph — `browserd/electron/**` is
 * reachable only from the local session factory, never from `protocol.ts` or
 * the daemon's own tree. The bundle-freshness test's recorded input list is
 * what catches a slip.
 *
 * `electron` appears here only as an `import type`, which erases: the
 * standalone Node server is built from this same source and must not resolve
 * it. The runtime `await import("electron")` lives in `electron-context.ts`,
 * behind an `ELECTRON_APP` check.
 */
import type { Debugger } from "electron";
import { logger } from "../../../utils/logger.js";
import type { CdpLike } from "../daemon/webmcp-bridge";

/** The session key for the ROOT target's own events; no id on the wire. */
const ROOT_SESSION = "";

/**
 * `webContents.debugger` as the bridge's `CdpLike`.
 *
 * Two shapes to reconcile. The debugger delivers EVERY protocol event through
 * one `"message"` listener carrying `(event, method, params)`; `CdpLike` wants
 * per-method subscription. So one listener fans out to a handler map.
 *
 * `CdpLike` has no `off`, which decides how teardown works: a bridge listener
 * cannot be individually removed, so `dispose()` flips `alive` and every one of
 * them becomes a no-op. Underneath, only the single `"message"` listener this
 * adapter installed is removed — by identity, not `removeAllListeners`, which
 * would be wrong on an emitter we do not exclusively own.
 *
 * ONE ADAPTER, MANY SESSIONS. Under flat auto-attach (`Target.setAutoAttach
 * {flatten: true}`) a cross-origin frame's events arrive through the SAME
 * `"message"` listener, distinguished only by the `sessionId` the typings carry
 * on both `sendCommand` and the `message` event. So the handler map is keyed by
 * (session, method) and {@link DebuggerCdpAdapter.childFor} mints a `CdpLike`
 * bound to one session id — which is all the WebMCP bridge needs to treat an
 * out-of-process frame like any other.
 */
export class DebuggerCdpAdapter implements CdpLike {
  /** sessionId → method → handlers. The root target lives under `""`. */
  private readonly handlers = new Map<
    string,
    Map<string, Array<(payload: unknown) => void>>
  >();
  private alive = true;
  private readonly onMessage: (
    event: unknown,
    method: string,
    params: unknown,
    sessionId?: string,
  ) => void;

  constructor(private readonly dbg: Debugger) {
    this.onMessage = (_event, method, params, sessionId) => {
      if (!this.alive) return;
      // A missing id is the root target's own event, which is every event at
      // all until something calls `Target.setAutoAttach`.
      const scope = this.handlers.get(sessionId ?? ROOT_SESSION);
      for (const handler of scope?.get(method) ?? []) {
        try {
          handler(params);
        } catch (error) {
          // A throwing subscriber is the consumer's own reaction to a browser
          // event; letting it escape would take down the listener that is also
          // responsible for the bridge's bookkeeping.
          logger.debug("[browserd] a CDP event handler threw", {
            method,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    this.dbg.on("message", this.onMessage);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.sendOn(ROOT_SESSION, method, params);
  }

  on(event: string, handler: (payload: unknown) => void): void {
    this.onFor(ROOT_SESSION, event, handler);
  }

  /**
   * A `CdpLike` bound to one auto-attached session — an out-of-process frame.
   *
   * Not a second adapter: there is one debugger and one `"message"` listener,
   * and a second `dbg.on("message")` per frame would deliver every event to
   * every frame's handler map. This is a view onto the same routing table.
   *
   * The caller gets it from `Target.attachedToTarget`'s `sessionId` and hands
   * it to `WebMcpBridge.addSession`; {@link forgetSession} on
   * `Target.detachedFromTarget` is what stops the routing table growing with
   * every frame the page has ever had.
   */
  childFor(sessionId: string): CdpLike {
    return {
      send: (method, params) => this.sendOn(sessionId, method, params),
      on: (event, handler) => this.onFor(sessionId, event, handler),
    };
  }

  /** Drop one session's handlers; the session itself is Chromium's to end. */
  forgetSession(sessionId: string): void {
    this.handlers.delete(sessionId);
  }

  private sendOn(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.alive) {
      return Promise.reject(new Error("The debugger has been detached."));
    }
    return sessionId
      ? this.dbg.sendCommand(method, params ?? {}, sessionId)
      : this.dbg.sendCommand(method, params ?? {});
  }

  private onFor(
    sessionId: string,
    event: string,
    handler: (payload: unknown) => void,
  ): void {
    const scope = this.handlers.get(sessionId) ?? new Map();
    const list = scope.get(event) ?? [];
    list.push(handler);
    scope.set(event, list);
    this.handlers.set(sessionId, scope);
  }

  /**
   * How many event handlers are registered, across all methods.
   *
   * Exists for tests. `CdpLike` has deliberately no `off`, so a caller that
   * subscribes per operation leaks a handler per call and nothing in the
   * public surface can see it — a leak test written against the underlying
   * emitter's `listenerCount` measures the ONE `"message"` listener installed
   * in the constructor and passes no matter how badly the map grows.
   */
  handlerCount(): number {
    let total = 0;
    for (const scope of this.handlers.values()) {
      for (const list of scope.values()) total += list.length;
    }
    return total;
  }

  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.handlers.clear();
    // By identity: `removeAllListeners("message")` would also take out anything
    // else that ever subscribed to this debugger, which is not ours to decide.
    this.dbg.removeListener("message", this.onMessage);
  }
}
