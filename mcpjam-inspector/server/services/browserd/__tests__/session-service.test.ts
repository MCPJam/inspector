import { describe, expect, it, vi } from "vitest";
import { BrowserSessionService } from "../session-service.js";

const SESSION = {
  sessionId: "logical-1",
  owner: { kind: "conversation", id: "chat-1" },
  projectId: "project-1",
  ownerUserId: "user-1",
  engine: "hosted",
  profile: "blank",
  state: "active",
  box: { sandboxRowId: "sandbox-row-1" },
  createdAt: 1,
  lastActiveAt: 2,
  lastCommandAt: 2,
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("BrowserSessionService", () => {
  it("reads a conversation through the authenticated get endpoint without opening it", async () => {
    const requestFetch = vi.fn(async () => response({ session: SESSION }));
    const service = new BrowserSessionService({
      baseUrl: "https://convex.example",
      enabled: true,
      fetch: requestFetch,
    });
    const signal = new AbortController().signal;
    expect(
      await service.getConversationSession({
        projectId: "project-1",
        conversationId: "chat-1",
        bearer: "user-token",
        signal,
      }),
    ).toMatchObject(SESSION);
    expect(requestFetch).toHaveBeenCalledWith(
      new URL("https://convex.example/browser-sessions/get"),
      expect.objectContaining({
        signal,
        method: "POST",
        body: JSON.stringify({
          projectId: "project-1",
          conversationId: "chat-1",
        }),
        headers: expect.objectContaining({
          authorization: "Bearer user-token",
        }),
      }),
    );
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });
  it("resolves a logical session through the authenticated data plane", async () => {
    const requestFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://convex.example/browser-sessions/open",
        );
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer user-token",
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          projectId: "project-1",
          owner: { kind: "conversation", id: "chat-1" },
        });
        return response({ session: SESSION });
      },
    );
    const service = new BrowserSessionService({
      baseUrl: "https://convex.example",
      enabled: true,
      fetch: requestFetch as unknown as typeof globalThis.fetch,
    });

    await expect(
      service.resolveSession({
        owner: { kind: "conversation", id: "chat-1" },
        projectId: "project-1",
        bearer: "user-token",
        engine: "hosted",
        profile: "blank",
      }),
    ).resolves.toMatchObject({
      sessionId: "logical-1",
      box: { sandboxRowId: "sandbox-row-1" },
    });
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it("stays a no-op for local-only installs", async () => {
    const requestFetch = vi.fn();
    const service = new BrowserSessionService({
      enabled: false,
      fetch: requestFetch as unknown as typeof globalThis.fetch,
    });

    await expect(
      service.resolveSession({
        owner: { kind: "conversation", id: "chat-1" },
        projectId: "project-1",
        bearer: "user-token",
        engine: "local",
        profile: "blank",
      }),
    ).resolves.toBeNull();
    expect(requestFetch).not.toHaveBeenCalled();
  });
});
