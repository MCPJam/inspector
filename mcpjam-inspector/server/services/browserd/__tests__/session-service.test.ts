import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionService } from "../session-service.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  describe("saved profile archives (MJ-005)", () => {
    const ARCHIVE_LOCATION =
      "https://files.convex.example/api/storage/0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
    const ARCHIVE = new Uint8Array([31, 139, 8, 0, 1, 2, 3]);

    function archiveFetch(location = ARCHIVE_LOCATION) {
      return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
        String(input) === "https://convex.example/browser-profiles/download-url"
          ? response({ url: location })
          : new Response(ARCHIVE, { status: 200 }),
      );
    }

    it("asks for the archive with the service token alongside the user's bearer", async () => {
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
      const requestFetch = archiveFetch();
      const service = new BrowserSessionService({
        baseUrl: "https://convex.example",
        enabled: true,
        storageOrigin: "https://files.convex.example",
        fetch: requestFetch as unknown as typeof globalThis.fetch,
      });

      const bytes = await service.downloadProfile({
        projectId: "project-1",
        profileId: "profile-1",
        bearer: "user-token",
      });

      expect(bytes).toEqual(ARCHIVE);
      expect(requestFetch).toHaveBeenCalledTimes(2);
      const [lookupUrl, lookupInit] = requestFetch.mock.calls[0] as unknown as [
        URL,
        RequestInit,
      ];
      expect(String(lookupUrl)).toBe(
        "https://convex.example/browser-profiles/download-url",
      );
      const lookupHeaders = new Headers(lookupInit.headers);
      expect(lookupHeaders.get("x-inspector-service-token")).toBe("svc-token");
      expect(lookupHeaders.get("authorization")).toBe("Bearer user-token");
      expect(JSON.parse(String(lookupInit.body))).toEqual({
        projectId: "project-1",
        profileId: "profile-1",
      });
      expect(lookupInit.redirect).toBe("error");

      // The archive read itself carries neither credential.
      const [archiveUrl, archiveInit] = requestFetch.mock
        .calls[1] as unknown as [URL, RequestInit];
      expect(String(archiveUrl)).toBe(ARCHIVE_LOCATION);
      expect(archiveInit.headers).toBeUndefined();
      expect(archiveInit.redirect).toBe("error");
    });

    it("leaves the service token off when this server holds none", async () => {
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
      const requestFetch = archiveFetch();
      const service = new BrowserSessionService({
        baseUrl: "https://convex.example",
        enabled: true,
        storageOrigin: "https://files.convex.example",
        fetch: requestFetch as unknown as typeof globalThis.fetch,
      });

      await service.resolveProfileArchive({
        projectId: "project-1",
        profileId: "profile-1",
        bearer: "user-token",
      });

      const lookupInit = requestFetch.mock.calls[0]![1] as RequestInit;
      expect(
        new Headers(lookupInit.headers).has("x-inspector-service-token"),
      ).toBe(false);
    });

    it("refuses an archive location that is not https", async () => {
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
      const requestFetch = archiveFetch(
        "http://files.convex.example/api/storage/0f1e2d3c",
      );
      const service = new BrowserSessionService({
        baseUrl: "https://convex.example",
        enabled: true,
        storageOrigin: "https://files.convex.example",
        fetch: requestFetch as unknown as typeof globalThis.fetch,
      });

      await expect(
        service.downloadProfile({
          projectId: "project-1",
          profileId: "profile-1",
          bearer: "user-token",
        }),
      ).rejects.toThrow(/must use https/);
      expect(requestFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["another host", "https://files.example/api/storage/0f1e2d3c"],
      ["another path", "https://files.convex.example/archive/profile-1"],
      [
        "embedded credentials",
        "https://user:pass@files.convex.example/api/storage/0f1e2d3c",
      ],
    ])(
      "reads an archive only from this deployment's file storage: refuses %s",
      async (_case, location) => {
        vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
        const requestFetch = archiveFetch(location);
        const service = new BrowserSessionService({
          baseUrl: "https://convex.example",
          enabled: true,
          storageOrigin: "https://files.convex.example",
          fetch: requestFetch as unknown as typeof globalThis.fetch,
        });

        await expect(
          service.downloadProfile({
            projectId: "project-1",
            profileId: "profile-1",
            bearer: "user-token",
          }),
        ).rejects.toThrow(/file storage/);
        // Only the lookup went out; the refused location was never requested.
        expect(requestFetch).toHaveBeenCalledTimes(1);
      },
    );

    it("accepts a Convex-hosted deployment's storage origin", async () => {
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
      const location =
        "https://happy-otter-123.convex.cloud/api/storage/0f1e2d3c-4b5a";
      const requestFetch = archiveFetch(location);
      const service = new BrowserSessionService({
        baseUrl: "https://convex.example",
        enabled: true,
        storageOrigin: "https://files.convex.example",
        fetch: requestFetch as unknown as typeof globalThis.fetch,
      });

      await expect(
        service.resolveProfileArchive({
          projectId: "project-1",
          profileId: "profile-1",
          bearer: "user-token",
        }),
      ).resolves.toEqual(new URL(location));
    });
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
