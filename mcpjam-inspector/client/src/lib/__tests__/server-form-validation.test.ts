import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerFormData } from "@/shared/types.js";

const importValidator = async (hosted: boolean) => {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({ HOSTED_MODE: hosted }));
  return (await import("../server-form-validation")).validateServerFormData;
};

const importBearerValidator = async () =>
  (await import("../server-form-validation")).validateBearerTargetUrl;

afterEach(() => {
  vi.doUnmock("@/lib/config");
  vi.resetModules();
});

function httpForm(overrides?: Partial<ServerFormData>): ServerFormData {
  return {
    name: "staging",
    type: "http",
    url: "https://staging.mcp.example.com",
    useOAuth: true,
    ...overrides,
  } as ServerFormData;
}

describe("validateServerFormData", () => {
  it("accepts a valid HTTP(S) server", async () => {
    const validate = await importValidator(false);
    expect(validate(httpForm())).toBeNull();
  });

  it("requires a URL for HTTP connections", async () => {
    const validate = await importValidator(false);
    expect(validate(httpForm({ url: "" }))).toMatch(/Enter your server’s URL/i);
  });

  it("rejects a malformed URL", async () => {
    const validate = await importValidator(false);
    expect(validate(httpForm({ url: "not a url" }))).toMatch(
      /Enter a complete server URL/i,
    );
  });

  it("requires a command for STDIO connections", async () => {
    const validate = await importValidator(false);
    expect(
      validate({ name: "x", type: "stdio", command: "" } as ServerFormData),
    ).toMatch(/Enter the command/i);
  });

  it("allows plain http in local mode", async () => {
    const validate = await importValidator(false);
    expect(validate(httpForm({ url: "http://localhost:8787/mcp" }))).toBeNull();
  });

  it("rejects plain http in hosted mode", async () => {
    const validate = await importValidator(true);
    expect(validate(httpForm({ url: "http://localhost:8787/mcp" }))).toMatch(
      /hosted web app requires an HTTPS/i,
    );
  });

  it("allows https in hosted mode", async () => {
    const validate = await importValidator(true);
    expect(validate(httpForm())).toBeNull();
  });

  it("allows STDIO in hosted mode for plugin components", async () => {
    const validate = await importValidator(true);
    expect(
      validate({ name: "x", type: "stdio", command: "node" } as ServerFormData),
    ).toBeNull();
  });
});

it.each([
  ["mcp.example.com/mcp", "http"],
  ["localhost:3000/mcp", "http"],
  ["ftp://host", "http"],
  ["ftp://host/server.js", "http"],
  ["mcp.example.com/server.js", "http"],
  ["HTTPS://mcp.example.com/mcp", "http"],
  ["npx -y server-example", "stdio"],
  ["server.js", "stdio"],
  ["server.py", "stdio"],
  ["./server.js", "stdio"],
  ["/usr/local/bin/server", "stdio"],
  ["server-example", "stdio"],
])("infers hosted input %s as %s", async (input, expected) => {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({ HOSTED_MODE: true }));
  const { inferFirstRunTransport } = await import("../server-form-validation");
  expect(inferFirstRunTransport(input)).toBe(expected);
});

it("preserves explicit transports and command inference in local mode", async () => {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({ HOSTED_MODE: false }));
  const { inferFirstRunTransport } = await import("../server-form-validation");
  expect(inferFirstRunTransport("server.example")).toBe("stdio");
  expect(inferFirstRunTransport("https://example.com", "stdio")).toBe("stdio");
  expect(inferFirstRunTransport("server.example", "http")).toBe("http");
});

describe("validateBearerTargetUrl", () => {
  it("rejects bearer credentials over public HTTP", async () => {
    const validate = await importBearerValidator();
    expect(validate("http://mcp.example.com/mcp")).toMatch(
      /require HTTPS for non-local/i,
    );
  });

  it.each([
    "http://localhost:8787/mcp",
    "http://127.0.0.1:8787/mcp",
    "http://192.168.1.10/mcp",
    "https://mcp.example.com/mcp",
  ])("allows a bearer credential for %s", async (url) => {
    const validate = await importBearerValidator();
    expect(validate(url)).toBeNull();
  });
});

describe("shared OAuth credential validation", () => {
  it("uses the same client ID and secret rules in both server forms", async () => {
    const { validateOAuthClientId, validateOAuthClientSecret } =
      await import("../server-form-validation");
    expect(validateOAuthClientId("ab")).toMatch(/at least 3 characters/);
    expect(validateOAuthClientId("abc")).toBeNull();
    expect(validateOAuthClientSecret("   ")).toMatch(/only whitespace/);
    expect(validateOAuthClientSecret("")).toBeNull();
  });

  it("blocks confidential CIMD until its identity is ready", async () => {
    const { getConfidentialCimdBlockReason } =
      await import("../server-form-validation");
    expect(getConfidentialCimdBlockReason(true, "loading")).toMatch(
      /Preparing/,
    );
    expect(getConfidentialCimdBlockReason(true, "ready")).toBeNull();
    expect(getConfidentialCimdBlockReason(false, "unavailable")).toBeNull();
  });
});
