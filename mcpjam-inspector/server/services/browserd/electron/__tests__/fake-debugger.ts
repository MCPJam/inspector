import { EventEmitter } from "node:events";
/** One `sendCommand` the provider made, in order. */
export interface CdpCall {
  method: string;
  params?: Record<string, unknown>;
  /**
   * The auto-attached session it was addressed to, if any.
   *
   * Electron's debugger carries `sessionId` on both `sendCommand` and the
   * `message` event, which is the whole mechanism by which an out-of-process
   * frame is reachable through ONE debugger. A fake that dropped it could not
   * tell a command sent to a frame from one sent to the page.
   */
  sessionId?: string;
}

export class FakeDebugger extends EventEmitter {
  readonly calls: CdpCall[] = [];
  attached = false;
  /** Set to make `attach` throw, as it does when devtools hold the slot. */
  attachError: Error | undefined;
  /** Per-method canned replies; anything unlisted resolves `{}`. */
  readonly replies = new Map<string, unknown>();

  attach(_version?: string): void {
    if (this.attachError) throw this.attachError;
    this.attached = true;
  }

  isAttached(): boolean {
    return this.attached;
  }

  detach(): void {
    this.attached = false;
  }

  async sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    this.calls.push({
      method,
      ...(params ? { params } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    // Session-scoped replies first, so a test can answer `Page.getFrameTree`
    // differently for a frame than for the page it is in.
    return (
      this.replies.get(sessionId ? `${sessionId}:${method}` : method) ??
      this.replies.get(method) ??
      {}
    );
  }

  /**
   * Play a protocol event back in Electron's own
   * `(event, method, params, sessionId)` shape. Omitting `sessionId` is the
   * page's own target, which is every event until something auto-attaches.
   */
  emitCdp(method: string, params: unknown, sessionId?: string): void {
    this.emit("message", { preventDefault() {} }, method, params, sessionId);
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}
