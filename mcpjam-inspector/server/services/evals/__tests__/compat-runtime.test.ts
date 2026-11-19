import { describe, expect, it, vi } from "vitest";

import { loadSuiteHostConfig } from "../compat-runtime";
import { WebRouteError } from "../../../routes/web/errors";
import { DEFAULT_HOST_STYLE_V2 } from "@mcpjam/sdk/host-config/templates";

type QueryImpl = (name: string, args: Record<string, unknown>) => unknown;

function fakeConvexClient(impl: QueryImpl) {
  return {
    query: vi.fn(async (name: string, args: Record<string, unknown>) =>
      impl(name, args),
    ),
  } as any;
}

describe("loadSuiteHostConfig — never hostless", () => {
  it("returns the named host's config when it exists", async () => {
    const client = fakeConvexClient((name) => {
      if (name === "hosts:getHost") {
        return { config: { hostStyle: "chatgpt" } };
      }
      throw new Error(`unexpected query: ${name}`);
    });

    await expect(
      loadSuiteHostConfig(client, "suite-1", "host-1"),
    ).resolves.toEqual({ hostStyle: "chatgpt" });
  });

  it("THROWS when a named host is requested but missing — never substitutes a default", async () => {
    // A miss on a NAMED host must fail fast: silently running as MCPJam would
    // mis-attribute a run the UI labelled "Claude"/"ChatGPT".
    const missing = fakeConvexClient((name) => {
      if (name === "hosts:getHost") return null;
      throw new Error(`unexpected query: ${name}`);
    });
    await expect(
      loadSuiteHostConfig(missing, "suite-1", "host-gone"),
    ).rejects.toBeInstanceOf(WebRouteError);

    const errored = fakeConvexClient((name) => {
      if (name === "hosts:getHost") throw new Error("convex down");
      throw new Error(`unexpected query: ${name}`);
    });
    await expect(
      loadSuiteHostConfig(errored, "suite-1", "host-gone"),
    ).rejects.toBeInstanceOf(WebRouteError);
  });

  it("returns the suite config when present and no host is named", async () => {
    const client = fakeConvexClient((name) => {
      if (name === "hostConfigsV2:getSuiteConfig") {
        return { hostStyle: "cursor" };
      }
      throw new Error(`unexpected query: ${name}`);
    });
    await expect(loadSuiteHostConfig(client, "suite-1")).resolves.toEqual({
      hostStyle: "cursor",
    });
  });

  it("falls back to the default MCPJam host (not null) when the suite has no config", async () => {
    const client = fakeConvexClient((name) => {
      if (name === "hostConfigsV2:getSuiteConfig") return null;
      throw new Error(`unexpected query: ${name}`);
    });
    const config = await loadSuiteHostConfig(client, "suite-1");
    expect(config).not.toBeNull();
    expect(config.hostStyle).toBe(DEFAULT_HOST_STYLE_V2);
  });

  it("falls back to the default host when getSuiteConfig throws", async () => {
    const client = fakeConvexClient((name) => {
      if (name === "hostConfigsV2:getSuiteConfig") throw new Error("convex down");
      throw new Error(`unexpected query: ${name}`);
    });
    const config = await loadSuiteHostConfig(client, "suite-1");
    expect(config.hostStyle).toBe(DEFAULT_HOST_STYLE_V2);
  });

  it("refuses instead when the caller enforces the host's policy", async () => {
    // The default host carries no XAA policy, so falling back on a failed
    // read would connect an enterprise host's servers without it.
    const outage = new Error("convex down");
    const client = fakeConvexClient((name) => {
      if (name === "hostConfigsV2:getSuiteConfig") throw outage;
      throw new Error(`unexpected query: ${name}`);
    });
    const refusal = await loadSuiteHostConfig(client, "suite-1", undefined, {
      failClosed: true,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(WebRouteError);
    expect(refusal).toMatchObject({
      status: 502,
      message: expect.stringContaining("authorization policy"),
      cause: outage,
    });
  });

  it("still uses the default host for a suite with no config when failing closed", async () => {
    const client = fakeConvexClient((name) => {
      if (name === "hostConfigsV2:getSuiteConfig") return null;
      throw new Error(`unexpected query: ${name}`);
    });
    const config = await loadSuiteHostConfig(client, "suite-1", undefined, {
      failClosed: true,
    });
    expect(config.hostStyle).toBe(DEFAULT_HOST_STYLE_V2);
  });
});
