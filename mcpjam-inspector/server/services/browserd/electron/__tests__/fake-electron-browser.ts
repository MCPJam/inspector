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
): Map<string, unknown> {
  return new Map<string, unknown>([
    ["DOM.getDocument", { root: { nodeId: 1 } }],
    ["DOM.querySelector", { nodeId: 42 }],
    ["DOM.describeNode", { node: { backendNodeId: 99 } }],
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
}

export class FakeBrowserWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  /** Every `loadURL` / `reload` / `goBack`, in order. */
  readonly navigations: string[] = [];
  /** Every `executeJavaScript` body, in order. */
  readonly evaluations: string[] = [];
  destroyed = false;
  focused = 0;
  windowOpenHandler: ((details: { url: string }) => unknown) | undefined;
  private url: string;
  private readonly options: FakeBrowserWebContentsOptions;
  private historyDepth = 0;

  constructor(options: FakeBrowserWebContentsOptions = {}) {
    super();
    this.options = options;
    this.url = options.startUrl ?? "about:blank";
  }

  async loadURL(url: string): Promise<void> {
    this.navigations.push(url);
    if (this.options.loadError) throw this.options.loadError;
    this.url = url;
    this.historyDepth += 1;
    this.emit("did-navigate", { preventDefault() {} }, url);
    return undefined;
  }

  reload(): void {
    this.navigations.push(`reload:${this.url}`);
    // Asynchronous, like the real one: the page commits after the caller has
    // already returned, which is exactly what the wait exists to catch.
    queueMicrotask(() => this.emit("did-finish-load"));
  }

  readonly navigationHistory = {
    canGoBack: () => this.historyDepth > 1,
    goBack: () => {
      this.navigations.push("goBack");
      this.historyDepth -= 1;
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

export class FakeBrowserWindow implements ElectronWindowLike {
  readonly webContents: FakeBrowserWebContents;
  destroyed = false;
  focusCount = 0;

  constructor(
    readonly options: Record<string, unknown>,
    contents?: FakeBrowserWebContents,
  ) {
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

export interface FakeElectron extends ElectronLike {
  /** Every window built, oldest first. */
  readonly windows: FakeBrowserWindow[];
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

  return {
    BrowserWindow,
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
    partitions,
    permissionRequestHandlers,
    permissionCheckHandlers,
  };
}
