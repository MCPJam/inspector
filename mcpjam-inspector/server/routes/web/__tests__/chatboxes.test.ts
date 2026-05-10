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
