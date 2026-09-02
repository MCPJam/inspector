/**
 * The slice of noVNC's `RFB` this codebase uses.
 *
 * The package ships no TypeScript types (it is plain ESM with JSDoc), and a
 * blanket `declare module "@novnc/novnc"` would make every property on it
 * `any` — including the two that matter for safety here. `viewOnly` is the
 * local courtesy gate, and the disconnect `code` is what distinguishes an
 * expired token (reconnect) from a browser that is gone (stop). Both are worth
 * having the compiler check.
 */
declare module "@novnc/novnc" {
  interface RfbOptions {
    /** Subprotocols on the handshake — where the browser token rides. */
    wsProtocols?: string[];
    credentials?: { username?: string; password?: string; target?: string };
    shared?: boolean;
    repeaterID?: string;
  }

  export default class RFB extends EventTarget {
    constructor(
      target: Element,
      urlOrChannel: string | WebSocket,
      options?: RfbOptions,
    );
    /** Local-only: the server-side filter is the gate that actually holds. */
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    disconnect(): void;
    focus(): void;
    blur(): void;
  }
}
