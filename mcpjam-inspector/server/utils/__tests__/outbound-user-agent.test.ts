import { afterEach, describe, expect, it, vi } from "vitest";

const appVersion = vi.hoisted(() => ({ value: "3.24.0" as string | null }));
vi.mock("../log-events.js", () => ({
  resolveAppVersion: () => appVersion.value,
}));

import { getDefaultUserAgent } from "@mcpjam/sdk";
import {
  applyInspectorUserAgent,
  withDefaultUserAgent,
} from "../outbound-user-agent.js";

const SLOT = Symbol.for("mcpjam.defaultUserAgent");

afterEach(() => {
  Reflect.deleteProperty(globalThis, SLOT);
  appVersion.value = "3.24.0";
  vi.unstubAllGlobals();
});

/** A fake `fetch` that keeps the headers of each request it is given. */
function recordingFetch() {
  const sent: Headers[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    sent.push(
      new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      )
    );
    return new Response("ok");
  });
  return { fetchFn, sent };
}

describe("applyInspectorUserAgent", () => {
  it("puts the app version in the default User-Agent", () => {
    applyInspectorUserAgent();

    expect(getDefaultUserAgent()).toBe(
      "MCPJam/3.24.0 (+https://mcpjam.com) MCP-Inspector/1.0"
    );
  });

  it("keeps the SDK default when the app version is unknown", () => {
    appVersion.value = null;

    applyInspectorUserAgent();

    expect(Reflect.get(globalThis, SLOT)).toBeUndefined();
    expect(getDefaultUserAgent()).toMatch(/^MCPJam\//);
  });
});

describe("withDefaultUserAgent", () => {
  it("adds MCPJam's User-Agent when the request has none", async () => {
    applyInspectorUserAgent();
    const { fetchFn, sent } = recordingFetch();

    await withDefaultUserAgent(fetchFn)("https://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    expect(sent[0].get("user-agent")).toBe(
      "MCPJam/3.24.0 (+https://mcpjam.com) MCP-Inspector/1.0"
    );
    expect(sent[0].get("content-type")).toBe("application/json");
    expect(fetchFn.mock.calls[0][1]?.method).toBe("POST");
  });

  it("keeps a User-Agent the caller set, in any letter case", async () => {
    const { fetchFn, sent } = recordingFetch();

    await withDefaultUserAgent(fetchFn)("https://example.test/mcp", {
      headers: { "USER-AGENT": "custom/1.0" },
    });

    expect(sent[0].get("user-agent")).toBe("custom/1.0");
  });

  it("keeps a Request's own headers", async () => {
    const { fetchFn, sent } = recordingFetch();
    const request = new Request("https://example.test/mcp", {
      headers: { "x-trace": "abc" },
    });

    await withDefaultUserAgent(fetchFn)(request);

    expect(sent[0].get("x-trace")).toBe("abc");
    expect(sent[0].get("user-agent")).toBe(getDefaultUserAgent());
  });

  it("dials the global fetch, looked up per call, when given none", async () => {
    const wrapped = withDefaultUserAgent();
    const { fetchFn, sent } = recordingFetch();
    vi.stubGlobal("fetch", fetchFn);

    await wrapped("https://example.test/mcp");

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(sent[0].get("user-agent")).toBe(getDefaultUserAgent());
  });
});
