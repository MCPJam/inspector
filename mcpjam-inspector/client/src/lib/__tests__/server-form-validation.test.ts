import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerFormData } from "@/shared/types.js";

const importValidator = async (hosted: boolean) => {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({ HOSTED_MODE: hosted }));
  return (await import("../server-form-validation")).validateServerFormData;
};

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
    expect(validate(httpForm({ url: "" }))).toMatch(/URL is required/i);
  });

  it("rejects a malformed URL", async () => {
    const validate = await importValidator(false);
    expect(validate(httpForm({ url: "not a url" }))).toMatch(
      /Invalid URL format/i,
    );
  });

  it("requires a command for STDIO connections", async () => {
    const validate = await importValidator(false);
    expect(
      validate({ name: "x", type: "stdio", command: "" } as ServerFormData),
    ).toMatch(/Command is required/i);
  });

  it("allows plain http in local mode", async () => {
    const validate = await importValidator(false);
    expect(validate(httpForm({ url: "http://localhost:8787/mcp" }))).toBeNull();
  });

  it("rejects plain http in hosted mode", async () => {
    const validate = await importValidator(true);
    expect(validate(httpForm({ url: "http://localhost:8787/mcp" }))).toMatch(
      /Hosted mode requires HTTPS/i,
    );
  });

  it("allows https in hosted mode", async () => {
    const validate = await importValidator(true);
    expect(validate(httpForm())).toBeNull();
  });
});
