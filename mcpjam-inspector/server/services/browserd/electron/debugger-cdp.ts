/**
 * `webContents.debugger` as a `CdpLike`.
 *
 * Lifted out of `webmcp-inspector/electron-webview-provider.ts`, which imports
 * it back, because two unrelated features now need it: that provider attaches
 * to a `<webview>` the renderer already mounted, and the Electron browser
 * engine drives hidden `BrowserWindow`s of its own. One adapter, so a fix to
 * either one is a fix to both.
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
 */
export class DebuggerCdpAdapter implements CdpLike {
  private readonly handlers = new Map<
    string,
    Array<(payload: unknown) => void>
  >();
  private alive = true;
  private readonly onMessage: (
    event: unknown,
    method: string,
    params: unknown,
  ) => void;

  constructor(private readonly dbg: Debugger) {
    this.onMessage = (_event, method, params) => {
      if (!this.alive) return;
      for (const handler of this.handlers.get(method) ?? []) {
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
    if (!this.alive) {
      return Promise.reject(new Error("The debugger has been detached."));
    }
    return this.dbg.sendCommand(method, params ?? {});
  }

  on(event: string, handler: (payload: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
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
