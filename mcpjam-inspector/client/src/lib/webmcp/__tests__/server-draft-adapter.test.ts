import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));

import { serverDraftToFormData } from "../server-draft-adapter";

describe("serverDraftToFormData", () => {
  it("builds an HTTP server with the form's own defaults", () => {
    // A server added by chat must behave like one added by hand: same
    // transport default, same auth ladder.
    const result = serverDraftToFormData({
      name: "Excalidraw",
      url: "https://example.com/mcp",
    });
    expect(result).toEqual({
      ok: true,
      formData: {
        name: "Excalidraw",
        type: "http",
        authMethod: "auto",
        url: "https://example.com/mcp",
      },
    });
  });

  it("emits headers through secretPatch as well as the field", () => {
    // secretPatch is a dirty-tracking replacement patch. Omit it and the
    // headers never reach Convex — the server would silently lose them.
    const result = serverDraftToFormData({
      name: "api",
      url: "https://example.com/mcp",
      headers: { "X-Key": "v" },
    });
    expect(result.ok).toBe(true);
    const formData = (result as { formData: any }).formData;
    expect(formData.headers).toEqual({ "X-Key": "v" });
    expect(formData.secretPatch).toEqual({ headers: { "X-Key": "v" } });
  });

  it("builds a STDIO server with pre-separated args", () => {
    const result = serverDraftToFormData({
      name: "local",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@scope/pkg", "--flag", "a b"],
      env: { TOKEN: "t" },
    });
    expect(result).toEqual({
      ok: true,
      formData: {
        name: "local",
        type: "stdio",
        authMethod: "auto",
        command: "npx",
        args: ["-y", "@scope/pkg", "--flag", "a b"],
        env: { TOKEN: "t" },
        secretPatch: { env: { TOKEN: "t" } },
      },
    });
  });

  it("trims the name and rejects an empty one", () => {
    expect(serverDraftToFormData({ name: "  x  ", url: "https://e.com" })).toMatchObject(
      { ok: true, formData: { name: "x" } },
    );
    // `validateServerFormData` does NOT check the name, and neither does the
    // connect path — so this adapter has to.
    for (const name of ["", "   ", undefined as never]) {
      expect(serverDraftToFormData({ name, url: "https://e.com" })).toEqual({
        ok: false,
        error: "Server name is required.",
      });
    }
  });

  it("relays the save path's own validation errors verbatim", () => {
    // Same message the user would see, and it tells the model what to fix.
    expect(
      serverDraftToFormData({ name: "x", url: "not-a-url" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("Invalid URL") });
    expect(
      serverDraftToFormData({ name: "x", transport: "stdio", command: "" }),
    ).toEqual({
      ok: false,
      error: "Command is required for STDIO connections",
    });
    expect(serverDraftToFormData({ name: "x" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("URL is required"),
    });
  });

  it("rejects fields belonging to the other transport instead of dropping them", () => {
    // A draft with both a url and a command is a misunderstanding worth
    // telling the model about, not something to silently half-apply.
    expect(
      serverDraftToFormData({ name: "x", url: "https://e.com", command: "npx" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("not a command") });
    expect(
      serverDraftToFormData({ name: "x", transport: "stdio", command: "npx", url: "https://e.com" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("not a url") });
    expect(
      serverDraftToFormData({ name: "x", url: "https://e.com", env: { A: "1" } }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("env applies to STDIO") });
    expect(
      serverDraftToFormData({ name: "x", transport: "stdio", command: "npx", headers: { A: "1" } }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("headers apply to HTTP") });
  });

  it("rejects an unknown transport", () => {
    expect(
      serverDraftToFormData({ name: "x", transport: "grpc" as never }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("Unknown transport") });
  });

  it("never emits credentials or identity config", () => {
    // The draft type has no room for them; assert the built form data agrees,
    // so a future field can't leak a secret from a chat transcript.
    const result = serverDraftToFormData({
      name: "x",
      url: "https://e.com/mcp",
    });
    const formData = (result as { formData: any }).formData;
    for (const key of [
      "clientSecret",
      "clientId",
      "oauthScopes",
      "xaaSubject",
      "xaaEmail",
    ]) {
      expect(formData).not.toHaveProperty(key);
    }
  });
});

describe("serverDraftToFormData in hosted mode", () => {
  it("enforces the hosted HTTPS rule via the shared validator", async () => {
    vi.resetModules();
    vi.doMock("@/lib/config", () => ({ HOSTED_MODE: true }));
    const { serverDraftToFormData: hostedAdapter } = await import(
      "../server-draft-adapter"
    );
    expect(hostedAdapter({ name: "x", url: "http://insecure.com/mcp" })).toEqual(
      { ok: false, error: "Hosted mode requires HTTPS server URLs" },
    );
    vi.doUnmock("@/lib/config");
    vi.resetModules();
  });
});
