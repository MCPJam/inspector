import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  initComputersRuntimeConfigBootstrap,
  resolveComputersLocalConfigured,
  resetComputersRuntimeConfigBootstrapForTests,
} from "../computers/runtime-config";
import {
  isComputersDataPlaneConfigured,
  resetServiceTokenRejectedForTests,
} from "../computers/control-plane-client";

// The bootstrap talks to Convex through global fetch; stub it and assert the
// env-mutation semantics (atomic, only-if-unset, fail-closed).

const ENV_KEYS = [
  "INSPECTOR_SERVICE_TOKEN",
  "CONVEX_HTTP_URL",
  "E2B_API_KEY",
  "E2B_API_URL",
  "E2B_DOMAIN",
  "E2B_TEMPLATE_ID",
  "COMPUTERS_TERMINAL_TOKEN_SECRET",
  "COMPUTERS_DATA_PLANE_SECRET",
] as const;

const savedEnv: Record<string, string | undefined> = {};
let fetchCalls: Array<{ url: string; headers: Record<string, string> }>;
let fetchImpl: () => Response | Promise<Response>;

const instantSleep = async () => {};

const ENABLED_PAYLOAD = {
  enabled: true,
  e2bApiKey: "boot-e2b-key",
  e2bApiUrl: null,
  e2bDomain: null,
  e2bTemplateId: "tmpl-boot",
  terminalTokenSecret: "boot-terminal-secret",
};

function jsonResponse(status: number, json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.INSPECTOR_SERVICE_TOKEN = "svc-tok";
  process.env.CONVEX_HTTP_URL = "https://convex.example.test";
  resetComputersRuntimeConfigBootstrapForTests();
  resetServiceTokenRejectedForTests();
  fetchCalls = [];
  fetchImpl = () => jsonResponse(200, ENABLED_PAYLOAD);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return fetchImpl();
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetComputersRuntimeConfigBootstrapForTests();
  resetServiceTokenRejectedForTests();
});

describe("initComputersRuntimeConfigBootstrap", () => {
  it("fetches with the service token and populates env atomically", async () => {
    const outcome = await initComputersRuntimeConfigBootstrap({
      sleep: instantSleep,
    });
    expect(outcome).toBe("applied");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://convex.example.test/internal/v1/computers/runtime-config"
    );
    expect(fetchCalls[0]!.headers["x-inspector-service-token"]).toBe("svc-tok");
    expect(process.env.E2B_API_KEY).toBe("boot-e2b-key");
    expect(process.env.E2B_TEMPLATE_ID).toBe("tmpl-boot");
    expect(process.env.COMPUTERS_TERMINAL_TOKEN_SECRET).toBe(
      "boot-terminal-secret"
    );
    // Nulls in the payload set nothing.
    expect(process.env.E2B_API_URL).toBeUndefined();
    // The bootstrap never manufactures the legacy secret.
    expect(process.env.COMPUTERS_DATA_PLANE_SECRET).toBeUndefined();
    // ...and the server now reports configured via the service token.
    expect(isComputersDataPlaneConfigured()).toBe(true);
  });

  it("never overwrites env vars that are already set", async () => {
    process.env.E2B_API_KEY = "operator-key";
    await initComputersRuntimeConfigBootstrap({ sleep: instantSleep });
    expect(process.env.E2B_API_KEY).toBe("operator-key");
    expect(process.env.COMPUTERS_TERMINAL_TOKEN_SECRET).toBe(
      "boot-terminal-secret"
    );
  });

  it("skips the fetch entirely without a service token", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    expect(
      await initComputersRuntimeConfigBootstrap({ sleep: instantSleep })
    ).toBe("skipped");
    expect(fetchCalls).toHaveLength(0);
  });

  it("skips the fetch when the legacy trio is already complete", async () => {
    process.env.E2B_API_KEY = "k";
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "s";
    process.env.COMPUTERS_DATA_PLANE_SECRET = "d";
    expect(
      await initComputersRuntimeConfigBootstrap({ sleep: instantSleep })
    ).toBe("skipped");
    expect(fetchCalls).toHaveLength(0);
  });

  it("treats 404 (old backend) and enabled:false as unavailable without retrying", async () => {
    fetchImpl = () => jsonResponse(404, { ok: false });
    expect(
      await initComputersRuntimeConfigBootstrap({ sleep: instantSleep })
    ).toBe("unavailable");
    expect(fetchCalls).toHaveLength(1);
    expect(process.env.E2B_API_KEY).toBeUndefined();

    resetComputersRuntimeConfigBootstrapForTests();
    fetchCalls = [];
    fetchImpl = () => jsonResponse(200, { enabled: false });
    expect(
      await initComputersRuntimeConfigBootstrap({ sleep: instantSleep })
    ).toBe("unavailable");
    expect(fetchCalls).toHaveLength(1);
    expect(process.env.E2B_API_KEY).toBeUndefined();
  });

  it("writes NOTHING when the payload fails validation (atomic apply)", async () => {
    fetchImpl = () =>
      jsonResponse(200, { enabled: true, e2bApiKey: "key-but-missing-rest" });
    const outcome = await initComputersRuntimeConfigBootstrap({
      sleep: instantSleep,
    });
    expect(outcome).toBe("failed");
    expect(process.env.E2B_API_KEY).toBeUndefined();
    expect(process.env.COMPUTERS_TERMINAL_TOKEN_SECRET).toBeUndefined();
  });

  it("retries network-ish failures (3 attempts) then fails closed", async () => {
    fetchImpl = () => {
      throw new Error("ECONNREFUSED");
    };
    const outcome = await initComputersRuntimeConfigBootstrap({
      sleep: instantSleep,
    });
    expect(outcome).toBe("failed");
    expect(fetchCalls).toHaveLength(3);
    expect(isComputersDataPlaneConfigured()).toBe(false);
  });

  it("memoizes: concurrent and repeat callers share one fetch", async () => {
    const [a, b] = await Promise.all([
      initComputersRuntimeConfigBootstrap({ sleep: instantSleep }),
      initComputersRuntimeConfigBootstrap({ sleep: instantSleep }),
    ]);
    expect(a).toBe("applied");
    expect(b).toBe("applied");
    await initComputersRuntimeConfigBootstrap({ sleep: instantSleep });
    expect(fetchCalls).toHaveLength(1);
  });

  it("re-inits after the failure cooldown, but not before", async () => {
    vi.useFakeTimers();
    try {
      fetchImpl = () => {
        throw new Error("ECONNREFUSED");
      };
      expect(
        await initComputersRuntimeConfigBootstrap({ sleep: instantSleep })
      ).toBe("failed");
      expect(fetchCalls).toHaveLength(3);

      // Within cooldown: no new fetch.
      expect(
        await initComputersRuntimeConfigBootstrap({ sleep: instantSleep })
      ).toBe("failed");
      expect(fetchCalls).toHaveLength(3);

      vi.advanceTimersByTime(61_000);
      fetchImpl = () => jsonResponse(200, ENABLED_PAYLOAD);
      expect(
        await initComputersRuntimeConfigBootstrap({ sleep: instantSleep })
      ).toBe("applied");
      expect(fetchCalls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveComputersLocalConfigured", () => {
  it("awaits the bootstrap before answering", async () => {
    expect(await resolveComputersLocalConfigured()).toBe(true);
    expect(fetchCalls).toHaveLength(1);
  });

  it("answers false when nothing is configured and no token exists", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    expect(await resolveComputersLocalConfigured()).toBe(false);
  });

  it("reports NOT configured after a 401 even with stray E2B + terminal secret in env", async () => {
    // Hybrid config: a wrong service token, no legacy secret, but leftover
    // hand-set E2B key + terminal secret. Without marking the token rejected,
    // the predicate would report localConfigured:true while every
    // secret-gated /computers/* call hard-401s.
    process.env.E2B_API_KEY = "stray-key";
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "stray-terminal-secret";
    delete process.env.COMPUTERS_DATA_PLANE_SECRET;
    fetchImpl = () => jsonResponse(401, { error: "Unauthorized" });

    expect(await resolveComputersLocalConfigured()).toBe(false);
    // A legacy secret is an independent credential and still counts.
    process.env.COMPUTERS_DATA_PLANE_SECRET = "legacy-secret";
    expect(isComputersDataPlaneConfigured()).toBe(true);
  });
});
