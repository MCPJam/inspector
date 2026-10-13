import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLastFailedRequest,
  installFailedRequestTracker,
} from "../failed-request-tracker";

const realFetch = window.fetch;
let uninstall: () => void;

function failFetchWith(error: unknown) {
  window.fetch = vi.fn().mockRejectedValue(error);
  uninstall = installFailedRequestTracker();
}

afterEach(() => {
  uninstall?.();
  window.fetch = realFetch;
  vi.useRealTimers();
});

describe("failed request tracker", () => {
  it("remembers the method and same-origin path, without the query", async () => {
    failFetchWith(new TypeError("Load failed"));

    await expect(
      fetch("/api/servers?token=secret", { method: "post" }),
    ).rejects.toThrow();

    expect(getLastFailedRequest()).toMatchObject({
      method: "POST",
      target: "/api/servers",
    });
  });

  it("keeps only the origin for cross-origin requests", async () => {
    failFetchWith(new TypeError("Failed to fetch"));

    await expect(
      fetch("https://mcp.example.com/secret-key/mcp"),
    ).rejects.toThrow();

    expect(getLastFailedRequest()?.target).toBe("https://mcp.example.com");
  });

  it("reads the method from a Request object", async () => {
    failFetchWith(new TypeError("Load failed"));

    await expect(
      fetch(new Request(`${window.location.origin}/api/x`, { method: "PUT" })),
    ).rejects.toThrow();

    expect(getLastFailedRequest()).toMatchObject({
      method: "PUT",
      target: "/api/x",
    });
  });

  it("rethrows the same error, message untouched", async () => {
    const error = new TypeError("Load failed");
    failFetchWith(error);

    const thrown = await fetch("/api/x").catch((e: unknown) => e);

    expect(thrown).toBe(error);
    expect((thrown as Error).message).toBe("Load failed");
  });

  it("ignores aborted requests", async () => {
    failFetchWith(new DOMException("The operation was aborted.", "AbortError"));

    await expect(fetch("/api/x")).rejects.toThrow();

    expect(getLastFailedRequest()).toBeNull();
  });

  it("leaves successful requests alone", async () => {
    const response = new Response("ok");
    window.fetch = vi.fn().mockResolvedValue(response);
    uninstall = installFailedRequestTracker();

    await expect(fetch("/api/x")).resolves.toBe(response);
    expect(getLastFailedRequest()).toBeNull();
  });

  it("is installed before any other module can save window.fetch", () => {
    // lib/oauth/mcp-oauth.ts saves window.fetch at load time and restores it
    // after each OAuth flow, which would drop a wrapper installed later.
    const mainSource = readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../../main.tsx"),
      "utf8",
    );
    const firstImport = mainSource.match(/^import .*$/m)?.[0];
    expect(firstImport).toBe('import "./lib/install-failed-request-tracker";');
  });
});
