/**
 * A fake Electron for the browser ENGINE, as distinct from the webview provider.
 *
 * Reuses `FakeDebugger` from `webmcp-inspector/__tests__/fake-electron.ts`
 * rather than growing a second one: the CDP adapter under test is now shared by
 * both features, so a divergence in the fake would hide a divergence in the
 * thing. What is new here is the surface the provider never needed — a
 * `BrowserWindow` constructor, `session.fromPartition`, and a `webContents`
 * that navigates rather than one that was handed to us already mounted.
 *
 * The debugger's `replies` map is the lever most tests pull: an act resolves a
 * selector through `DOM.getDocument` → `DOM.querySelector` → `DOM.getBoxModel`,
 * and canning those three is how a test says "the button is at (50, 60)"
 * without a DOM.
 */
import { EventEmitter } from "node:events";
import { FakeDebugger } from "../../../webmcp-inspector/__tests__/fake-electron";
import type { ElectronLike, ElectronWindowLike } from "../electron-context";

export { FakeDebugger };

/** Canned replies that put one element at a known box. */
export function elementAt(
  x: number,
  y: number,
  size = 10,
  /**
   * What `DOM.describeNode` says this node IS.
   *
   * The fill path classifies over CDP rather than in the page, so a fixture
   * that answers no `nodeName` models an element the protocol cannot describe
   * — which is refused, not filled. Defaults to a plain text input, the shape
   * the click and hover fixtures want.
   */
  describe: { nodeName?: string; attributes?: string[] } = { nodeName: "INPUT" },
): Map<string, unknown> {
  return new Map<string, unknown>([
    ["DOM.getDocument", { root: { nodeId: 1 } }],
    ["DOM.querySelector", { nodeId: 42 }],
    ["DOM.describeNode", { node: { backendNodeId: 99, ...describe } }],
    [
      "DOM.getBoxModel",
      {
        model: {
          content: [
            x - size,
            y - size,
            x + size,
            y - size,
            x + size,
            y + size,
            x - size,
            y + size,
          ],
        },
      },
    ],
  ]);
}

/** Canned replies for a selector that matches nothing. */
export function noElement(): Map<string, unknown> {
  return new Map<string, unknown>([
    ["DOM.getDocument", { root: { nodeId: 1 } }],
    ["DOM.querySelector", { nodeId: 0 }],
  ]);
}

export interface FakeBrowserWebContentsOptions {
  startUrl?: string;
  /** Answers `executeJavaScript`, by the code passed in. */
  evaluate?: (code: string) => Promise<unknown> | unknown;
  /** Makes `loadURL` reject, the way a dead host does. */
  loadError?: Error;
  /** Replaces `loadURL` entirely — a load that never settles, say. */
  loadURL?: (url: string) => Promise<void>;
}

export class FakeBrowserWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  /** Every `loadURL` / `reload` / `goBack`, in order. */
  readonly navigations: string[] = [];
  /** Every `executeJavaScript` body, in order. */
  readonly evaluations: string[] = [];
  destroyed = false;
  focused = 0;
  /** How many times a load was called off. */
  stopped = 0;
  /** Where a load actually commits, when that differs from what was asked. */
  redirectTo: string | undefined;
  windowOpenHandler: ((details: { url: string }) => unknown) | undefined;
  private url: string;
  private readonly options: FakeBrowserWebContentsOptions;
  private historyDepth = 0;
  /** How many entries are AHEAD of the current one; `goBack` creates them. */
  private forwardDepth = 0;

  constructor(options: FakeBrowserWebContentsOptions = {}) {
    super();
    this.options = options;
    this.url = options.startUrl ?? "about:blank";
  }

  async loadURL(url: string): Promise<void> {
    this.navigations.push(url);
    if (this.options.loadURL) return this.options.loadURL(url);
    if (this.options.loadError) throw this.options.loadError;
    const committed = this.redirectTo ?? url;
    this.url = committed;
    this.historyDepth += 1;
    // A fresh navigation truncates the forward history, as every browser does:
    // go back twice, then follow a link, and there is nothing ahead any more.
    this.forwardDepth = 0;
    this.emit("did-navigate", { preventDefault() {} }, committed);
    return undefined;
  }

  stop(): void {
    this.stopped += 1;
  }

  /**
   * A frame this reload should report as having failed, before it commits.
   *
   * `[url, isMainFrame]`, mirroring Electron's own argument order, so a test
   * can model the routine case: a blocked ad iframe fails while the document
   * behind it loads perfectly.
   */
  failFrameOnNextLoad?: { description: string; isMainFrame: boolean };

  reload(): void {
    this.navigations.push(`reload:${this.url}`);
    // Asynchronous, like the real one: the page commits after the caller has
    // already returned, which is exactly what the wait exists to catch.
    queueMicrotask(() => {
      const failure = this.failFrameOnNextLoad;
      if (failure) {
        this.failFrameOnNextLoad = undefined;
        // Electron's signature: event, errorCode, errorDescription,
        // validatedURL, isMainFrame.
        this.emit(
          "did-fail-load",
          { preventDefault() {} },
          -1,
          failure.description,
          "https://ads.test/pixel",
          failure.isMainFrame,
        );
        if (failure.isMainFrame) return;
      }
      this.emit("did-finish-load");
    });
  }

  readonly navigationHistory = {
    canGoBack: () => this.historyDepth > 1,
    goBack: () => {
      this.navigations.push("goBack");
      this.historyDepth -= 1;
      this.forwardDepth += 1;
      queueMicrotask(() => this.emit("did-finish-load"));
    },
    canGoForward: () => this.forwardDepth > 0,
    goForward: () => {
      this.navigations.push("goForward");
      this.historyDepth += 1;
      this.forwardDepth -= 1;
      queueMicrotask(() => this.emit("did-finish-load"));
    },
  };

  async executeJavaScript(code: string): Promise<unknown> {
    this.evaluations.push(code);
    return this.options.evaluate?.(code);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  focus(): void {
    this.focused += 1;
  }

  setWindowOpenHandler(handler: (details: { url: string }) => unknown): void {
    this.windowOpenHandler = handler;
  }

  /** Log a console message the way Electron 30+ does, as one event object. */
  logConsole(level: string, message: string): void {
    this.emit("console-message", { level, message });
  }

  /** Log the way older Electron builds do, positionally. */
  logConsoleLegacy(level: number, message: string): void {
    this.emit("console-message", { preventDefault() {} }, level, message);
  }

  currentUrl(): string {
    return this.url;
  }
}

let nextWindowId = 1;

export class FakeBrowserWindow implements ElectronWindowLike {
  readonly webContents: FakeBrowserWebContents;
  /** Real `BrowserWindow`s have one, and the agent-window registry keys on it. */
  readonly id: number;
  destroyed = false;
  focusCount = 0;
  contentSize: { width: number; height: number } | undefined;

  setContentSize(width: number, height: number): void {
    this.contentSize = { width, height };
  }

  constructor(
    readonly options: Record<string, unknown>,
    contents?: FakeBrowserWebContents,
  ) {
    this.id = nextWindowId++;
    this.webContents = contents ?? new FakeBrowserWebContents();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.webContents.destroyed = true;
  }

  focus(): void {
    this.focusCount += 1;
  }
}

/**
 * A `WebContentsView` double.
 *
 * The native surface's unit: a real one is Chromium with no window of its own,
 * moved between windows by its parent's `contentView`.
 */
export class FakeWebContentsView {
  readonly webContents: FakeBrowserWebContents;
  bounds: { x: number; y: number; width: number; height: number } | undefined;

  constructor(
    readonly options: Record<string, unknown>,
    contents?: FakeBrowserWebContents,
  ) {
    this.webContents = contents ?? new FakeBrowserWebContents();
  }

  setBounds(next: { x: number; y: number; width: number; height: number }): void {
    this.bounds = next;
  }

  getBounds() {
    return this.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  }
}

/** A `BaseWindow` double: a container, not a page. */
export class FakeBaseWindow {
  readonly id: number;
  readonly children: FakeWebContentsView[] = [];
  destroyed = false;
  readonly contentView = {
    addChildView: (view: FakeWebContentsView) => {
      if (!this.children.includes(view)) this.children.push(view);
    },
    removeChildView: (view: FakeWebContentsView) => {
      const at = this.children.indexOf(view);
      if (at >= 0) this.children.splice(at, 1);
    },
  };

  constructor(readonly options: Record<string, unknown>) {
    this.id = nextWindowId++;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

export interface FakeElectron extends ElectronLike {
  /** Every window built, oldest first. */
  readonly windows: FakeBrowserWindow[];
  /** Every holder built. There should never be more than one per context. */
  readonly holders: FakeBaseWindow[];
  /** Every view built, oldest first. */
  readonly views: FakeWebContentsView[];
  /** Partitions `session.fromPartition` was asked for, in order. */
  readonly partitions: string[];
  /** Permission handlers installed, so a test can call one. */
  readonly permissionRequestHandlers: Array<(...args: never[]) => void>;
  readonly permissionCheckHandlers: Array<(...args: never[]) => void>;
}

/**
 * A fake `electron` module.
 *
 * `nextContents` lets a test pre-seed the `webContents` a window will get, so
 * canned CDP replies can be in place before the context ever builds one.
 */
export function fakeElectron(
  nextContents: FakeBrowserWebContents[] = [],
): FakeElectron {
  const windows: FakeBrowserWindow[] = [];
  const holders: FakeBaseWindow[] = [];
  const views: FakeWebContentsView[] = [];
  const partitions: string[] = [];
  const permissionRequestHandlers: Array<(...args: never[]) => void> = [];
  const permissionCheckHandlers: Array<(...args: never[]) => void> = [];

  const BrowserWindow = function (
    this: unknown,
    options: Record<string, unknown>,
  ) {
    const window = new FakeBrowserWindow(options, nextContents.shift());
    windows.push(window);
    return window;
  } as unknown as ElectronLike["BrowserWindow"];

  const BaseWindow = function (
    this: unknown,
    options: Record<string, unknown>,
  ) {
    const window = new FakeBaseWindow(options);
    holders.push(window);
    return window;
  } as unknown as NonNullable<ElectronLike["BaseWindow"]>;

  const WebContentsView = function (
    this: unknown,
    options: Record<string, unknown>,
  ) {
    const view = new FakeWebContentsView(options, nextContents.shift());
    views.push(view);
    return view;
  } as unknown as NonNullable<ElectronLike["WebContentsView"]>;

  return {
    BrowserWindow,
    BaseWindow,
    WebContentsView,
    session: {
      fromPartition(partition: string) {
        partitions.push(partition);
        return {
          setPermissionRequestHandler(handler: unknown) {
            if (handler) {
              permissionRequestHandlers.push(
                handler as (...a: never[]) => void,
              );
            }
          },
          setPermissionCheckHandler(handler: unknown) {
            if (handler) {
              permissionCheckHandlers.push(handler as (...a: never[]) => void);
            }
          },
        };
      },
    },
    windows,
    holders,
    views,
    partitions,
    permissionRequestHandlers,
    permissionCheckHandlers,
  };
}
