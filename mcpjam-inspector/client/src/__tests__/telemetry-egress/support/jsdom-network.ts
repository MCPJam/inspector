/**
 * Every way a page can send bytes, replaced by a recorder — for the jsdom
 * egress harness.
 *
 * posthog-js and Sentry capture the transports they use when they LOAD
 * (posthog-js reads `fetch` and `XMLHttpRequest` off the global at module
 * evaluation; Sentry binds `fetch` when the client is created), so this must
 * be installed before either SDK is imported. Each test file runs in its own
 * worker, so "before" means: at the top of the file, before the dynamic
 * imports that boot the app.
 *
 * Nothing reaches a network. Requests are recorded with their bytes and
 * answered from `respond`, the stand-in for PostHog's relay and Sentry's
 * ingest. `<script src>` loads are emulated too: posthog-js fetches its remote
 * config as a script (`/array/<token>/config.js`), and jsdom never loads
 * scripts, so the recorder runs the response's effect and fires `load`
 * exactly as a browser would after executing it.
 */
import type { CapturedRequest } from "../../../../../e2e/telemetry/egress";

export interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface ScriptResponse {
  /** Runs in place of the script's code. */
  run: () => void;
}

export interface NetworkStub {
  requests: CapturedRequest[];
  /** Resolves once every recorded body (Blobs are async) has been read. */
  settle(): Promise<void>;
  /** Requests recorded since `mark`. */
  since(mark: number): CapturedRequest[];
  restore(): void;
}

async function bodyBytes(body: unknown): Promise<Uint8Array | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }
  const blob = body as Blob;
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof FileReader !== "undefined" && body instanceof Blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  }
  // Unknown body type: fail loudly rather than record nothing.
  throw new Error(`network stub: cannot read a ${typeof body} body`);
}

function headersOf(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function installNetworkStub(
  respond: (request: CapturedRequest) => StubResponse | ScriptResponse | null,
): NetworkStub {
  const requests: CapturedRequest[] = [];
  const pending: Promise<unknown>[] = [];
  const win = window as unknown as Record<string, unknown>;
  const original = {
    fetch: globalThis.fetch,
    windowFetch: win.fetch,
    xhr: globalThis.XMLHttpRequest,
    beacon: navigator.sendBeacon,
  };

  const record = (
    url: string,
    method: string,
    transport: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<CapturedRequest> => {
    const entry: CapturedRequest = { url, method, transport, headers, body: null };
    // Recorded synchronously (order matters for "requests since"), the body
    // filled in once read.
    requests.push(entry);
    const read = bodyBytes(body).then((bytes) => {
      entry.body = bytes;
      return entry;
    });
    pending.push(read);
    return read;
  };

  const toResponse = (answer: StubResponse | ScriptResponse | null) => {
    const plain = answer && !("run" in answer) ? answer : null;
    return new Response(plain?.body ?? "{}", {
      status: plain?.status ?? (answer ? 200 : 404),
      headers: { "content-type": "application/json", ...(plain?.headers ?? {}) },
    });
  };

  const stubFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(
      request ? request.url : String(input),
      window.location.href,
    ).toString();
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body =
      init?.body ?? (request && method !== "GET" ? await request.arrayBuffer() : null);
    const entry = await record(
      url,
      method,
      "fetch",
      { ...headersOf(request?.headers), ...headersOf(init?.headers) },
      body,
    );
    return toResponse(respond(entry));
  };

  class StubXMLHttpRequest {
    // `withCredentials` must exist: posthog-js only uses XHR when it does.
    withCredentials = false;
    readyState = 0;
    status = 0;
    responseText = "";
    response = "";
    timeout = 0;
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private method = "GET";
    private url = "";
    private headers: Record<string, string> = {};
    open(method: string, url: string) {
      this.method = method.toUpperCase();
      this.url = new URL(url, window.location.href).toString();
      this.readyState = 1;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    }
    getResponseHeader() {
      return null;
    }
    getAllResponseHeaders() {
      return "";
    }
    abort() {}
    send(body?: unknown) {
      void record(this.url, this.method, "xhr", this.headers, body).then(
        (entry) => {
          const answer = respond(entry);
          const plain = answer && !("run" in answer) ? answer : null;
          this.status = plain?.status ?? (answer ? 200 : 404);
          this.responseText = plain?.body ?? "{}";
          this.response = this.responseText;
          this.readyState = 4;
          this.onreadystatechange?.();
          this.onload?.();
        },
      );
    }
  }

  const stubBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
    void record(
      new URL(String(url), window.location.href).toString(),
      "POST",
      "sendBeacon",
      {},
      data ?? null,
    );
    return true;
  };

  // Scripts: watch for `<script src>` and play the browser's part.
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLScriptElement) || !node.src) return;
        void record(node.src, "GET", "script", {}, null).then((entry) => {
          const answer = respond(entry);
          if (answer && "run" in answer) {
            answer.run();
            node.dispatchEvent(new Event("load"));
          } else {
            node.dispatchEvent(new Event("error"));
          }
        });
      });
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  globalThis.fetch = stubFetch as typeof fetch;
  win.fetch = stubFetch;
  globalThis.XMLHttpRequest =
    StubXMLHttpRequest as unknown as typeof XMLHttpRequest;
  win.XMLHttpRequest = StubXMLHttpRequest;
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: stubBeacon,
  });

  return {
    requests,
    async settle() {
      // Bodies can be read late (Blobs); new requests can be recorded while
      // waiting, so loop until nothing is pending.
      let count = -1;
      while (count !== pending.length) {
        count = pending.length;
        await Promise.all(pending);
      }
    },
    since(mark: number) {
      return requests.slice(mark);
    },
    restore() {
      observer.disconnect();
      globalThis.fetch = original.fetch;
      win.fetch = original.windowFetch;
      globalThis.XMLHttpRequest = original.xhr;
      win.XMLHttpRequest = original.xhr;
      Object.defineProperty(navigator, "sendBeacon", {
        configurable: true,
        writable: true,
        value: original.beacon,
      });
    },
  };
}
