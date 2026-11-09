// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../config.js", () => ({
  HOSTED_MODE: true,
  SANDBOX_HOSTS: new Set(["sandbox.example"]),
}));
import { prepareHostedSandboxView } from "../sandbox-view-hosted.js";
import { WebRouteError } from "../../routes/web/errors.js";
import {
  sandboxViewIdentity,
  type SandboxViewLease,
} from "../sandbox-view-lease.js";
import {
  openSandboxViewCapability,
  prepareSandboxViewSchema,
  sandboxDigest,
} from "../sandbox-view-policy.js";

const owner = sandboxDigest("owner");
const input = () =>
  prepareSandboxViewSchema.parse({
    viewInstanceId: "639f5fd0-f977-4813-b90f-d57cf2bf7c46",
    source: {
      serverId: "server",
      resourceUri: "ui://view",
      toolCallId: "call",
    },
    html: "<!doctype html><p>view</p>",
    mode: "declared",
    hostOrigin: "https://app.example",
    policy: { permissive: false },
  });
beforeEach(() => {
  vi.stubEnv(
    "INSPECTOR_SERVICE_TOKEN",
    "sandbox-test-service-credential-32-characters",
  );
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example");
  vi.stubEnv("VITE_MCPJAM_SANDBOX_ORIGIN", "https://sandbox.example");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("hosted App document lease client", () => {
  it("keeps the capability URL stable across authenticated lease renewal", async () => {
    let lease: SandboxViewLease | undefined;
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/read"))
        return lease
          ? Response.json({ lease })
          : Response.json(
              { code: "SANDBOX_VIEW_LEASE_UNAVAILABLE" },
              { status: 409 },
            );
      if (url.endsWith("/create")) {
        const fields = { ...body, generation: "server-generation-1" };
        lease = {
          ...fields,
          identityHash: sandboxViewIdentity(fields),
          expiresAt: Date.now() + 7200000,
        };
      } else if (url.endsWith("/renew") && lease) lease.expiresAt += 1000;
      return Response.json({ lease });
    });
    vi.stubGlobal("fetch", transport);
    const first = await prepareHostedSandboxView(input(), owner);
    const second = await prepareHostedSandboxView(
      { ...input(), admissionId: first.admissionId },
      owner,
    );
    expect(second.proxyUrl).toBe(first.proxyUrl);
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
    const url = new URL(first.proxyUrl);
    const identity = openSandboxViewCapability(
      url.searchParams.get("view_token")!,
      url.origin,
    );
    expect(identity.identityHash).toBe(lease?.identityHash);
    expect(() =>
      openSandboxViewCapability(
        url.searchParams.get("view_token")!,
        "https://other.example",
      ),
    ).toThrow("Invalid App");
    expect(
      transport.mock.calls.every(
        ([, init]) =>
          new Headers(init.headers).get("x-inspector-service-token") ===
            "sandbox-test-service-credential-32-characters" &&
          init.redirect === "error",
      ),
    ).toBe(true);
  });

  it.each([
    ["set alone", undefined, "https://sandbox.example"],
    [
      "set with an unlisted build-time value",
      "https://other.example",
      "https://sandbox.example",
    ],
    [
      "invalid, beside a listed build-time value",
      "https://sandbox.example",
      "not an origin",
    ],
  ])(
    "mints view origins from the sandbox origin the browser is served, with MCPJAM_SANDBOX_ORIGIN %s",
    async (_label, buildTime, runtime) => {
      vi.stubEnv("VITE_MCPJAM_SANDBOX_ORIGIN", buildTime);
      vi.stubEnv("MCPJAM_SANDBOX_ORIGIN", runtime);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          if (url.endsWith("/read"))
            return Response.json(
              { code: "SANDBOX_VIEW_LEASE_UNAVAILABLE" },
              { status: 409 },
            );
          const fields = {
            ...JSON.parse(String(init.body)),
            generation: "server-generation-1",
          };
          return Response.json({
            lease: {
              ...fields,
              identityHash: sandboxViewIdentity(fields),
              expiresAt: Date.now() + 7200000,
            },
          });
        }),
      );
      const view = await prepareHostedSandboxView(input(), owner);
      expect(new URL(view.proxyUrl).hostname).toMatch(
        /^v-[0-9a-f]{16}\.sandbox\.example$/,
      );
    },
  );

  it.each([
    ["invalid JSON", () => new Response("not-json")],
    ["missing lease", () => Response.json({})],
    ["invalid lease schema", () => Response.json({ lease: { keyHash: 1 } })],
  ])("reports %s as a retryable service failure", async (_label, result) => {
    vi.stubGlobal("fetch", vi.fn(async () => result()));
    await expect(prepareHostedSandboxView(input(), owner)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("does not retry or forward a service request when transport rejects a redirect", async () => {
    const transport = vi.fn(async (_url: string, _init: RequestInit) => {
      throw new TypeError("Redirect rejected");
    });
    vi.stubGlobal("fetch", transport);
    await expect(prepareHostedSandboxView(input(), owner)).rejects.toBeInstanceOf(
      WebRouteError,
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("does not emit a capability for a validly hashed lease belonging to another owner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/read")) return Response.json({}, { status: 409 });
        const fields = {
          ...JSON.parse(String(init.body)),
          ownerHash: sandboxDigest("different-owner"),
          generation: "server-generation-2",
        };
        return Response.json({
          lease: {
            ...fields,
            identityHash: sandboxViewIdentity(fields),
            expiresAt: Date.now() + 7200000,
          },
        });
      }),
    );
    await expect(prepareHostedSandboxView(input(), owner)).rejects.toThrow(
      "differs from its admission",
    );
  });
});
