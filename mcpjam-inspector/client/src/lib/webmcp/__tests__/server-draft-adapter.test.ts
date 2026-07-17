import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));

import {
  serverDraftToFormData,
  serverDraftToPrefill,
} from "../server-draft-adapter";

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

  it("builds a STDIO server with pre-separated args", () => {
    const result = serverDraftToFormData({
      name: "local",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@scope/pkg", "--flag", "a b"],
    });
    expect(result).toEqual({
      ok: true,
      formData: {
        name: "local",
        type: "stdio",
        authMethod: "auto",
        command: "npx",
        args: ["-y", "@scope/pkg", "--flag", "a b"],
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
  });

  it("rejects an unknown transport", () => {
    expect(
      serverDraftToFormData({ name: "x", transport: "grpc" as never }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("Unknown transport") });
  });

  it("never emits credentials, identity config, OR secret-bearing env/headers", () => {
    // The draft type has no room for any of these; assert the built form data
    // agrees, so a future field can't leak a secret from a chat transcript.
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
      "env",
      "headers",
      "secretPatch",
    ]) {
      expect(formData).not.toHaveProperty(key);
    }
  });
});

describe("serverDraftToPrefill", () => {
  it("returns undefined for a blank/absent draft so the form opens empty", () => {
    expect(serverDraftToPrefill(undefined)).toEqual({ ok: true, prefill: undefined });
    expect(serverDraftToPrefill({})).toEqual({ ok: true, prefill: undefined });
  });

  it("shapes a partial draft WITHOUT requiring a name or endpoint", () => {
    // The whole point of opening the form is to let the user finish — a
    // missing name or url must not be an error here.
    expect(serverDraftToPrefill({ name: "Excalidraw" })).toEqual({
      ok: true,
      prefill: { type: "http", authMethod: "auto", name: "Excalidraw" },
    });
    expect(serverDraftToPrefill({ url: "https://e.com/mcp" })).toEqual({
      ok: true,
      prefill: { type: "http", authMethod: "auto", url: "https://e.com/mcp" },
    });
  });

  it("still rejects a genuine contradiction the user couldn't fix in the form", () => {
    expect(
      serverDraftToPrefill({ url: "https://e.com", command: "npx" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("not a command") });
    expect(
      serverDraftToPrefill({ transport: "grpc" as never }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("Unknown transport") });
  });
});

describe("serverDraftToFormData in hosted mode", () => {
  it("enforces the hosted HTTPS rule via the shared validator", async () => {
    // try/finally so a failed assertion can't leak the { HOSTED_MODE: true }
    // mock into later tests in this file.
    vi.resetModules();
    vi.doMock("@/lib/config", () => ({ HOSTED_MODE: true }));
    try {
      const { serverDraftToFormData: hostedAdapter } = await import(
        "../server-draft-adapter"
      );
      expect(
        hostedAdapter({ name: "x", url: "http://insecure.com/mcp" }),
      ).toEqual({ ok: false, error: "Hosted mode requires HTTPS server URLs" });
    } finally {
      vi.doUnmock("@/lib/config");
      vi.resetModules();
    }
  });
});
