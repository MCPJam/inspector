/**
 * A browser that is not a browser: drives every lifecycle and queue test
 * without a Chromium. The real protocol behaviour is covered against a live
 * browser in `webmcp-cdp.spike.test.ts` and the provider integration test — so
 * these fakes are free to be simple, and the suites that use them are free to
 * be fast and deterministic.
 */
import type { WebMcpViewportTransport } from "@/shared/webmcp-inspector-protocol";
import {
  WebMcpInvocationCancelledError,
  type CreateWebMcpSessionOptions,
  type ProviderToolDescriptor,
  type WebMcpBrowserProvider,
  type WebMcpBrowserSession,
  type WebMcpInvokeRequest,
  type WebMcpSessionCallbacks,
} from "../provider";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function fakeTool(
  overrides: Partial<ProviderToolDescriptor> = {},
): ProviderToolDescriptor {
  return {
    frameId: "frame-main",
    name: "echo",
    description: "Echoes",
    inputSchema: { type: "object", properties: {} },
    origin: "https://example.test",
    isMainFrame: true,
    registrationKind: "imperative",
    ...overrides,
  };
}

export class FakeBrowserSession implements WebMcpBrowserSession {
  disposed = false;
  navigations: string[] = [];
  screenshots = 0;
  /** Resolve/reject to settle an in-flight invocation from a test. */
  pending: Deferred<{ output: unknown }> | undefined;
  /** When set, invokeTool hangs until the test settles `pending`. */
  hangOnInvoke = false;
  invocations: WebMcpInvokeRequest[] = [];
  private url: string;

  constructor(
    readonly callbacks: WebMcpSessionCallbacks,
    startUrl = "https://example.test/",
    /** Held so a test can await teardown ordering deterministically. */
    private readonly disposeGate?: Deferred<void>,
  ) {
    this.url = startUrl;
  }

  emitTools(tools: ProviderToolDescriptor[]): void {
    this.callbacks.onToolsChanged(tools);
  }

  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    this.url = url;
  }
  async reload(): Promise<void> {
    this.navigations.push(this.url);
  }
  async goBack(): Promise<void> {
    this.navigations.push("back");
  }

  async invokeTool(request: WebMcpInvokeRequest): Promise<{ output: unknown }> {
    this.invocations.push(request);
    if (!this.hangOnInvoke) {
      return { output: { echoed: request.input } };
    }
    this.pending = deferred<{ output: unknown }>();
    request.signal.addEventListener(
      "abort",
      () => {
        const timedOut = request.signal.reason === "timeout";
        this.pending?.reject(
          new WebMcpInvocationCancelledError(
            timedOut ? "timed out" : "cancelled",
            timedOut ? "timeout" : "cancelled",
          ),
        );
      },
      { once: true },
    );
    return this.pending.promise;
  }

  async captureScreenshot(): Promise<string | undefined> {
    this.screenshots += 1;
    return "ZmFrZS1zY3JlZW5zaG90";
  }

  currentUrl(): string {
    return this.url;
  }

  viewportTransport(): WebMcpViewportTransport {
    return { kind: "native-window" };
  }

  async dispose(): Promise<void> {
    if (this.disposeGate) await this.disposeGate.promise;
    this.disposed = true;
  }
}

export class FakeProvider implements WebMcpBrowserProvider {
  readonly sessions: FakeBrowserSession[] = [];
  /** Gate every launch, to test the reserve-before-launch capacity window. */
  launchGate: Deferred<void> | undefined;
  /** Throw this instead of launching. */
  failWith: Error | undefined;
  disposeGate: Deferred<void> | undefined;

  async createSession(
    options: CreateWebMcpSessionOptions,
  ): Promise<WebMcpBrowserSession> {
    if (this.launchGate) await this.launchGate.promise;
    if (this.failWith) throw this.failWith;
    const session = new FakeBrowserSession(
      options.callbacks,
      options.url,
      this.disposeGate,
    );
    this.sessions.push(session);
    return session;
  }
}
