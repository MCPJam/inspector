import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, expectJson, postJson } from "./helpers/test-app.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

describe("web routes — chatboxes redeem", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  it("surfaces a deployment mismatch when the upstream chatbox route is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "missing route" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const response = await postJson(
      app,
      "/api/web/chatboxes/redeem",
      { chatboxToken: "chatbox-link-token" },
      token,
    );
    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(response);

    expect(status).toBe(404);
    expect(data.code).toBe("NOT_FOUND");
  });

  it("maps an upstream 429 to RATE_LIMITED (not UNAUTHORIZED)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "slow down" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const response = await postJson(
      app,
      "/api/web/chatboxes/redeem",
      { chatboxToken: "chatbox-link-token" },
      token,
    );
    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(response);

    expect(status).toBe(429);
    expect(data.code).toBe("RATE_LIMITED");
  });

  it("keeps an archived scenario's 410 and forwards ENV_ARCHIVED in details", async () => {
    // The link redeemed fine; its environment was archived on purpose. This
    // used to reach the visitor as a generic failure, which reads as "MCPJam
    // is broken" rather than "the owner retired this".
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error:
              "This link has been archived by its owner and can no longer be opened.",
            code: "ENV_ARCHIVED",
          }),
          { status: 410, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const response = await postJson(
      app,
      "/api/web/chatboxes/redeem",
      { chatboxToken: "chatbox-link-token" },
      token,
    );
    const { status, data } = await expectJson<{
      code: string;
      message: string;
      details?: { code?: string };
    }>(response);

    expect(status).toBe(410);
    // Top-level code is this route's TRANSPORT classification…
    expect(data.code).toBe("CONFLICT");
    // …the domain reason rides in details, so the client can pick its copy.
    expect(data.details?.code).toBe("ENV_ARCHIVED");
    expect(data.message).toContain("archived by its owner");
  });

  it("maps a 409 (environment unresolvable) to CONFLICT too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: "This link isn't available right now.",
            code: "ENV_PLUGIN_UNAVAILABLE",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const response = await postJson(
      app,
      "/api/web/chatboxes/redeem",
      { chatboxToken: "chatbox-link-token" },
      token,
    );
    const { status, data } = await expectJson<{
      code: string;
      details?: { code?: string };
    }>(response);

    expect(status).toBe(409);
    expect(data.code).toBe("CONFLICT");
    expect(data.details?.code).toBe("ENV_PLUGIN_UNAVAILABLE");
  });

  it("omits details when the upstream sent no domain code", async () => {
    // Absence stays absence: a bare 403 must not grow an empty details block
    // the client would then branch on.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "nope" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const response = await postJson(
      app,
      "/api/web/chatboxes/redeem",
      { chatboxToken: "chatbox-link-token" },
      token,
    );
    const { status, data } = await expectJson<{
      code: string;
      details?: unknown;
    }>(response);

    expect(status).toBe(403);
    expect(data.code).toBe("FORBIDDEN");
    expect(data.details).toBeUndefined();
  });

  it("coerces 2xx with ok:false to a 502 instead of leaking a misleading 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, error: "upstream contract violation" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const response = await postJson(
      app,
      "/api/web/chatboxes/redeem",
      { chatboxToken: "chatbox-link-token" },
      token,
    );
    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(response);

    expect(status).toBe(502);
    expect(data.code).toBe("SERVER_UNREACHABLE");
  });

  it("returns the redeem payload on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            chatboxId: "sbx_1",
            role: "chat",
            mode: "invited_only",
            projectId: "ws_1",
            accessVersion: 3,
            bootstrap: {
              projectId: "ws_1",
              chatboxId: "sbx_1",
              name: "Host Styled Chatbox",
              hostStyle: "chatgpt",
              mode: "invited_only",
              allowGuestAccess: false,
              viewerIsProjectMember: true,
              systemPrompt: "You are helpful.",
              modelId: "openai/gpt-5-mini",
              temperature: 0.4,
              requireToolApproval: true,
              servers: [],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const response = await postJson(
      app,
      "/api/web/chatboxes/redeem",
      { chatboxToken: "chatbox-link-token" },
      token,
    );
    const { status, data } = await expectJson<{
      chatboxId: string;
      role: string;
      mode: string;
      projectId: string;
      accessVersion: number;
      bootstrap: { name: string };
    }>(response);

    expect(status).toBe(200);
    expect(data).toMatchObject({
      chatboxId: "sbx_1",
      role: "chat",
      mode: "invited_only",
      projectId: "ws_1",
      accessVersion: 3,
      bootstrap: expect.objectContaining({ name: "Host Styled Chatbox" }),
    });
  });
});
