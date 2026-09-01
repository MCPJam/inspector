/**
 * A fake Electron, for driving `electron-webview-provider.ts` without one.
 *
 * Mirrors the `FakeCdp` pattern the Playwright suites use — a command ledger
 * plus an `emit` that plays protocol events back — and adds what the debugger
 * shape needs on top: Electron delivers EVERY event through one `"message"`
 * listener carrying `(event, method, params)`, so the fake's `emitCdp` speaks
 * that shape rather than a per-method one. A fake that emitted per-method would
 * pass against an adapter that never fanned out at all.
 *
 * MODELLED FROM REALITY, not from a blank slate. Two details are here because
 * the production code's behaviour is only meaningful against them:
 *
 *   - the guest is born with a window-open handler already installed, because
 *     `src/main.ts` installs one app-wide on EVERY created webContents. The
 *     provider REPLACES that, and dispose leaves a deny behind — a change from
 *     what the guest had. Against a blank slate that replace/restore pair would
 *     look like tidy bookkeeping instead of the behaviour change it is.
 *   - listener bookkeeping is exact, so "dispose removed our listeners and left
 *     everyone else's" is a real assertion rather than a count.
 */
import { EventEmitter } from "node:events";
import type { Session, WebContents } from "electron";
import { WEBMCP_WEBVIEW_PARTITION } from "@/shared/webmcp-inspector-protocol";
import type { ElectronModuleLike } from "../electron-webview-provider";

/** One `sendCommand` the provider made, in order. */
export interface CdpCall {
  method: string;
  params?: Record<string, unknown>;
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
  ): Promise<unknown> {
    this.calls.push({ method, ...(params ? { params } : {}) });
    return this.replies.get(method) ?? {};
  }

  /** Play a protocol event back in Electron's own `(event, method, params)` shape. */
  emitCdp(method: string, params: unknown): void {
    this.emit("message", { preventDefault() {} }, method, params);
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

/** What `capturePage()` resolves to: enough `NativeImage` to exercise the budget. */
export interface FakeImageOptions {
  empty?: boolean;
  /** Bytes `toJPEG` returns, by quality. */
  jpegBytes: (quality: number) => number;
  /** Bytes after a `resize`, by quality. Defaults to a quarter of `jpegBytes`. */
  resizedJpegBytes?: (quality: number) => number;
}

export interface FakeImage {
  isEmpty(): boolean;
  toJPEG(quality: number): Buffer;
  resize(options: { width: number }): FakeImage;
  /** Widths passed to `resize`, so the retry's geometry can be asserted. */
  readonly resizes: number[];
}

export function fakeImage(options: FakeImageOptions): FakeImage {
  const resizes: number[] = [];
  const make = (resized: boolean): FakeImage => ({
    isEmpty: () => options.empty === true,
    toJPEG: (quality: number) =>
      Buffer.alloc(
        resized
          ? (
              options.resizedJpegBytes ??
              ((q: number) => options.jpegBytes(q) / 4)
            )(quality)
          : options.jpegBytes(quality),
        0x41,
      ),
    resize: ({ width }) => {
      resizes.push(width);
      return make(true);
    },
    resizes,
  });
  return make(false);
}

export interface FakeWebContentsOptions {
  id?: number;
  type?: string;
  session?: Session;
  host?: WebContents | null;
  startUrl?: string;
  /** Resolves the page-API probe; `false` models a browser with WebMCP off. */
  probe?: () => Promise<unknown>;
  capture?: () => Promise<FakeImage>;
  loadURL?: (url: string) => Promise<void>;
}

type WindowOpenHandler = (details: { url: string }) => unknown;

export class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  readonly id: number;
  readonly session: Session;
  readonly hostWebContents: WebContents | null;
  destroyed = false;
  private url: string;
  private readonly type: string;
  /** Every `loadURL`/`reload`/`goBack`, in order. */
  readonly navigations: string[] = [];
  /**
   * Window-open handlers ever installed, oldest first.
   *
   * The FIRST entry is the app-wide handler `src/main.ts` puts on every created
   * webContents; the provider's is the second, and the deny it leaves on
   * dispose is the third. The slot is single-writer in Electron, so the history
   * is the only way to see the replacement happen.
   */
  readonly windowOpenHandlers: WindowOpenHandler[] = [];
  private readonly options: FakeWebContentsOptions;

  constructor(options: FakeWebContentsOptions = {}) {
    super();
    this.options = options;
    this.id = options.id ?? 42;
    this.type = options.type ?? "webview";
    this.session = options.session ?? (fakePartitionSession() as Session);
    this.hostWebContents = options.host ?? null;
    this.url = options.startUrl ?? "about:blank";
    // As born: the app-wide handler is already there before anything attaches.
    this.windowOpenHandlers.push(() => ({ action: "deny" }));
  }

  getType(): string {
    return this.type;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getURL(): string {
    return this.url;
  }

  async loadURL(url: string): Promise<void> {
    this.navigations.push(url);
    if (this.options.loadURL) await this.options.loadURL(url);
    this.url = url;
  }

  reload(): void {
    this.navigations.push(`reload:${this.url}`);
    queueMicrotask(() => this.emit("did-stop-loading"));
  }

  readonly navigationHistory = {
    goBack: () => {
      this.navigations.push("goBack");
      queueMicrotask(() => this.emit("did-stop-loading"));
    },
  };

  async executeJavaScript(_code: string): Promise<unknown> {
    return this.options.probe ? this.options.probe() : true;
  }

  async capturePage(): Promise<FakeImage> {
    if (!this.options.capture) {
      return fakeImage({ jpegBytes: () => 1_000 });
    }
    return this.options.capture();
  }

  setWindowOpenHandler(handler: WindowOpenHandler): void {
    this.windowOpenHandlers.push(handler);
  }

  /** The handler currently in the single-writer slot. */
  currentWindowOpenHandler(): WindowOpenHandler {
    return this.windowOpenHandlers[this.windowOpenHandlers.length - 1]!;
  }

  /** Set the URL as a real navigation would, then announce it. */
  navigateTo(url: string, inPage = false): void {
    this.url = url;
    if (inPage) this.emit("did-navigate-in-page", {}, url, true);
    else this.emit("did-navigate", {}, url);
  }

  /** Total listeners across every event, for the dispose assertions. */
  listenerCount_all(): number {
    return this.eventNames().reduce(
      (total, name) => total + this.listenerCount(name),
      0,
    );
  }
}

/**
 * A distinct object per partition string, compared by identity — exactly how
 * the provider's ownership check compares `wc.session` to
 * `session.fromPartition(...)`. A fake returning a fresh object each call would
 * make that check fail for every guest, including a legitimate one.
 */
const partitionSessions = new Map<string, Session>();
export function fakePartitionSession(
  partition: string = WEBMCP_WEBVIEW_PARTITION,
): Session {
  const existing = partitionSessions.get(partition);
  if (existing) return existing;
  const created = { partition } as unknown as Session;
  partitionSessions.set(partition, created);
  return created;
}

export interface FakeElectronOptions {
  /** Surfaces reachable by `webContents.fromId`. */
  contents?: FakeWebContents[];
  /** Windows whose `webContents` count as "one of ours". */
  windows?: Array<{ webContents: WebContents }>;
}

export interface FakeElectron extends ElectronModuleLike {
  readonly contents: FakeWebContents[];
}

export function fakeElectron(options: FakeElectronOptions = {}): FakeElectron {
  const contents = options.contents ?? [];
  return {
    contents,
    webContents: {
      fromId: (id: number) =>
        contents.find((wc) => wc.id === id) as unknown as
          WebContents | undefined,
    },
    session: {
      fromPartition: (partition: string) => fakePartitionSession(partition),
    },
    BrowserWindow: { getAllWindows: () => options.windows ?? [] },
  };
}

/**
 * A guest that passes every ownership check, plus the window that hosts it.
 *
 * The default for tests about anything OTHER than the guard, so those tests do
 * not each re-derive four conditions and drift on which one they got wrong.
 */
export function ownedGuest(options: FakeWebContentsOptions = {}): {
  guest: FakeWebContents;
  electron: FakeElectron;
} {
  const hostContents = new FakeWebContents({ id: 1, type: "window" });
  const host = hostContents as unknown as WebContents;
  const guest = new FakeWebContents({ host, ...options });
  const electron = fakeElectron({
    contents: [guest, hostContents],
    windows: [{ webContents: host }],
  });
  return { guest, electron };
}

/** Callback spies, with one ordered log so cross-callback ordering is assertable. */
export function recordingCallbacks() {
  const log: string[] = [];
  const navigated: Array<{ url: string; origin: string }> = [];
  const popups: string[] = [];
  const crashes: string[] = [];
  const toolSnapshots: unknown[][] = [];
  let activity = 0;
  return {
    log,
    navigated,
    popups,
    crashes,
    toolSnapshots,
    activityCount: () => activity,
    callbacks: {
      onToolsChanged: (tools: unknown[]) => {
        log.push("tools");
        toolSnapshots.push(tools);
      },
      onNavigated: (url: string, origin: string) => {
        log.push(`navigated:${url}`);
        navigated.push({ url, origin });
      },
      onPopupOpened: (url: string) => {
        log.push(`popup:${url}`);
        popups.push(url);
      },
      onExternalInvocation: () => log.push("external"),
      onActivityObserved: () => {
        activity += 1;
        log.push("activity");
      },
      onCrashed: (message: string) => {
        log.push(`crash:${message}`);
        crashes.push(message);
      },
      onFrame: () => log.push("frame"),
    },
  };
}
