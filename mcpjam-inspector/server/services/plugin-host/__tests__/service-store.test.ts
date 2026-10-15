import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginServiceStore,
  PLUGIN_FAST_STORE_RETRY_MS,
  resetPluginFastStoreDetection,
} from "../service-store.js";
import { PluginInvocationError } from "../invocation.js";
import {
  INVOCATION_RECEIPT_PATH,
  PLUGIN_INSTANCE_CONTROL_PATH,
} from "../../../../shared/plugin-invocation-receipts.js";

const CONVEX_URL = "https://fixture.convex.cloud";
const env = {
  INSPECTOR_SERVICE_TOKEN: "synthetic-service-token",
  CONVEX_HTTP_URL: "https://fixture.convex.site",
  CONVEX_URL,
};
type Sent = { url: string; headers: Headers; body: any };
/** A deployment double: the Convex client API and the HTTP routes. */
function deployment(answer: (sent: Sent) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    };
    sent.push(request);
    return answer(request);
  }) as typeof fetch;
  return { fetchImpl, sent };
}
const convex = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const success = (value: unknown) =>
  convex({ status: "success", value, logLines: [] });
const missing = (path: string) =>
  convex({
    status: "error",
    errorMessage: `[Request ID: 1] Server Error\nCould not find public function for '${path}'.\n`,
  });
const store = (
  fetchImpl: typeof fetch,
  path = PLUGIN_INSTANCE_CONTROL_PATH,
  overrides: Record<string, string | undefined> = {},
) =>
  createPluginServiceStore(path, 64 * 1024, "INSTANCE_STORE_UNAVAILABLE", {
    env: { ...env, ...overrides },
    fetchImpl,
  })!;
const signal = () => AbortSignal.timeout(5_000);

beforeEach(() => resetPluginFastStoreDetection());
afterEach(() => vi.restoreAllMocks());

describe("plugin service store transport", () => {
  it("sends reads to the service query and writes to the service mutation, with the service credential only", async () => {
    const { fetchImpl, sent } = deployment(({ url, body }) =>
      success(
        url.endsWith("/api/query") ? { control: null } : { ok: body.path },
      ),
    );
    const controls = store(fetchImpl);
    await expect(
      controls(
        { action: "read", identityHash: "i", controlHash: "c" },
        signal(),
      ),
    ).resolves.toEqual({ control: null });
    await expect(
      controls({ action: "renew", expiresAt: 1 }, signal()),
    ).resolves.toEqual({ ok: "pluginInstanceControls:serviceApply" });
    const receipts = store(fetchImpl, INVOCATION_RECEIPT_PATH);
    await receipts({ action: "read", scopeHash: "s" }, signal());
    await receipts({ action: "claim", scopeHash: "s" }, signal());
    expect(sent.map(({ url, body }) => [url, body.path])).toEqual([
      [`${CONVEX_URL}/api/query`, "pluginInstanceControls:serviceRead"],
      [`${CONVEX_URL}/api/mutation`, "pluginInstanceControls:serviceApply"],
      [`${CONVEX_URL}/api/query`, "pluginInvocationReceipts:serviceRead"],
      [`${CONVEX_URL}/api/mutation`, "pluginInvocationReceipts:serviceApply"],
    ]);
    for (const { headers, body } of sent) {
      expect(headers.get("authorization")).toBeNull();
      expect(body.args[0].serviceToken).toBe(env.INSPECTOR_SERVICE_TOKEN);
    }
    // The command is the HTTP route's body, unchanged.
    expect(sent[0].body.args[0].command).toEqual({
      action: "read",
      identityHash: "i",
      controlHash: "c",
    });
    // Each read is fresh: a per-call id keeps the query cache out of it.
    expect(sent[0].body.args[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[2].body.args[0].requestId).not.toBe(
      sent[0].body.args[0].requestId,
    );
    expect(sent[1].body.args[0].requestId).toBeUndefined();
  });

  it("answers a refusal with its code, exactly like the HTTP route", async () => {
    const { fetchImpl, sent } = deployment(() =>
      convex({
        status: "error",
        errorMessage: "",
        errorData: { code: "INSTANCE_UNAVAILABLE" },
      }),
    );
    await expect(
      store(fetchImpl)({ action: "read" }, signal()),
    ).rejects.toMatchObject({ code: "INSTANCE_UNAVAILABLE" });
    const malformed = deployment(() =>
      convex({
        status: "error",
        errorMessage: "",
        errorData: { code: "not a code" },
      }),
    );
    await expect(
      store(malformed.fetchImpl)({ action: "read" }, signal()),
    ).rejects.toMatchObject({ code: "INSTANCE_STORE_UNAVAILABLE" });
    // A refusal never retries over HTTP.
    expect(sent.every(({ url }) => url.startsWith(CONVEX_URL))).toBe(true);
  });

  it("never retries a failed or uncertain call over HTTP", async () => {
    for (const answer of [
      () => convex({ status: "error", errorMessage: "Server Error" }),
      () => new Response("upstream", { status: 502 }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => success({ big: "x".repeat(70 * 1024) }),
    ]) {
      const { fetchImpl, sent } = deployment(answer);
      const error = await store(fetchImpl)(
        { action: "context", expectedVersion: 0 },
        signal(),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PluginInvocationError);
      expect(error).toMatchObject({ code: "INSTANCE_STORE_UNAVAILABLE" });
      // A mutation may have committed before a lost answer: no second send.
      expect(sent).toHaveLength(1);
    }
  });

  it("falls back to the HTTP route on a backend without the functions, then asks again later", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let deployed = false;
    const { fetchImpl, sent } = deployment(({ url, body }) => {
      if (url.startsWith(CONVEX_URL))
        return deployed ? success({ fast: true }) : missing(body.path);
      return convex({ http: true });
    });
    const controls = store(fetchImpl);
    await expect(controls({ action: "read" }, signal())).resolves.toEqual({
      http: true,
    });
    // The fallback carries the same command to the route, with its header.
    expect(sent.map(({ url }) => url)).toEqual([
      `${CONVEX_URL}/api/query`,
      `${env.CONVEX_HTTP_URL}${PLUGIN_INSTANCE_CONTROL_PATH}`,
    ]);
    expect(sent[1].body).toEqual({ action: "read" });
    expect(sent[1].headers.get("x-inspector-service-token")).toBe(
      env.INSPECTOR_SERVICE_TOKEN,
    );
    // Remembered: the next calls go straight to the route.
    sent.length = 0;
    await controls({ action: "read" }, signal());
    await store(fetchImpl)({ action: "read" }, signal());
    expect(sent.every(({ url }) => !url.startsWith(CONVEX_URL))).toBe(true);
    // Writes are a separate function and are detected on their own.
    sent.length = 0;
    await controls({ action: "renew" }, signal());
    expect(sent.map(({ url }) => url.startsWith(CONVEX_URL))).toEqual([
      true,
      false,
    ]);
    // Once the backend deploys, the fast path returns within the window.
    deployed = true;
    now += PLUGIN_FAST_STORE_RETRY_MS;
    sent.length = 0;
    await expect(controls({ action: "read" }, signal())).resolves.toEqual({
      fast: true,
    });
    expect(sent).toHaveLength(1);
  });

  it("uses only the HTTP route without a usable Convex URL", async () => {
    for (const CONVEX_URL of [undefined, "", "not a url"]) {
      const { fetchImpl, sent } = deployment(() => convex({ http: true }));
      await expect(
        store(fetchImpl, PLUGIN_INSTANCE_CONTROL_PATH, { CONVEX_URL })(
          { action: "read" },
          signal(),
        ),
      ).resolves.toEqual({ http: true });
      expect(sent.map(({ url }) => url)).toEqual([
        `${env.CONVEX_HTTP_URL}${PLUGIN_INSTANCE_CONTROL_PATH}`,
      ]);
    }
  });

  it("observes cancellation as the HTTP route does", async () => {
    const controller = new AbortController();
    // Like fetch, the double rejects when its request signal aborts.
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        ),
      )) as typeof fetch;
    const pending = store(fetchImpl)({ action: "read" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "INSTANCE_STORE_UNAVAILABLE",
    });
  });
});
