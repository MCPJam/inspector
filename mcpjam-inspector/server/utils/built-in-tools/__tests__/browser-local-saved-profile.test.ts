/**
 * A local browser's first boot with a saved profile attached (the backend
 * attaches the user's default profile to every new conversation session).
 *
 * The profile is never a precondition for the browser: when it cannot be
 * fetched — this server holds no service token, or the download fails — the
 * browser boots blank, the chat gets one short notice, and it is logged.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  ensureLocal: vi.fn(),
  resolveSession: vi.fn(),
  downloadProfile: vi.fn(),
  bindBox: vi.fn(),
  recordBoot: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../../computers/browser-consent.js", () => ({
  verifyAndFingerprintBrowserConsent: vi.fn(async () => "consent-fp"),
  verifyLocalBrowserConsent: vi.fn(async () => true),
}));

vi.mock(
  "../../../services/browserd/local/local-browser-session.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    ensureLocalBrowserSession: hoisted.ensureLocal,
    localBrowserKeyFor: vi.fn(() => "local-key-1"),
    resolveLocalBrowserRuntime: vi.fn(() => "playwright"),
  }),
);

vi.mock("../../../services/browserd/session-service.js", () => ({
  BrowserSessionService: class {
    enabled = true;
    resolveSession = hoisted.resolveSession;
    downloadProfile = hoisted.downloadProfile;
    bindBox = hoisted.bindBox;
    recordBoot = hoisted.recordBoot;
    touch = vi.fn(async () => true);
    setTabs = vi.fn(async () => true);
    close = vi.fn(async () => true);
  },
}));

vi.mock("../../logger.js", () => ({
  logger: {
    warn: hoisted.warn,
    info: hoisted.info,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  buildBrowserTools,
  downloadSavedProfileForLocalBoot,
  SAVED_PROFILE_LOAD_FAILED_NOTICE,
  SAVED_PROFILE_UNAVAILABLE_NOTICE,
} from "../browser";

const ARCHIVE = new Uint8Array([1, 2, 3]);
const originalToken = process.env.INSPECTOR_SERVICE_TOKEN;

function localHandle() {
  return {
    engine: "local" as const,
    sessionId: "local-sess-1",
    bootId: "boot-1",
    contextMode: "persistent" as const,
    reused: false,
    client: {
      sendCommand: vi.fn(async () => ({
        status: "ok",
        bootId: "boot-1",
        result: { ok: true, output: {} },
      })),
      status: vi.fn(async () => ({ bootId: "boot-1" })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INSPECTOR_SERVICE_TOKEN = "service-token-1";
  hoisted.ensureLocal.mockResolvedValue(localHandle());
  hoisted.resolveSession.mockResolvedValue({
    sessionId: "bs_1",
    owner: { kind: "conversation", id: "chat-a" },
    projectId: "project-1",
    ownerUserId: "user-1",
    engine: "local",
    profile: "blank",
    profileId: "bp_default",
    state: "active",
    createdAt: 1,
    lastActiveAt: 1,
    lastCommandAt: 1,
  });
  hoisted.downloadProfile.mockResolvedValue(ARCHIVE);
  hoisted.bindBox.mockResolvedValue({ sessionId: "bs_1" });
  hoisted.recordBoot.mockResolvedValue(true);
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INSPECTOR_SERVICE_TOKEN;
  else process.env.INSPECTOR_SERVICE_TOKEN = originalToken;
});

describe("downloadSavedProfileForLocalBoot", () => {
  const service = { downloadProfile: hoisted.downloadProfile };
  const args = {
    service,
    projectId: "project-1",
    profileId: "bp_default",
    bearer: "Bearer user",
  };

  it("returns the archive when it loads, with no notice", async () => {
    const onNotice = vi.fn();

    await expect(
      downloadSavedProfileForLocalBoot({ ...args, onNotice }),
    ).resolves.toBe(ARCHIVE);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("does not ask for the archive on a server without a service token", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    const onNotice = vi.fn();

    await expect(
      downloadSavedProfileForLocalBoot({ ...args, onNotice }),
    ).resolves.toBeNull();
    expect(hoisted.downloadProfile).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      SAVED_PROFILE_UNAVAILABLE_NOTICE,
    );
    expect(hoisted.info).toHaveBeenCalledOnce();
  });

  it("boots blank, says so and logs it when the download fails", async () => {
    hoisted.downloadProfile.mockRejectedValue(
      new Error("browser profile download returned 404"),
    );
    const onNotice = vi.fn();

    await expect(
      downloadSavedProfileForLocalBoot({ ...args, onNotice }),
    ).resolves.toBeNull();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      SAVED_PROFILE_LOAD_FAILED_NOTICE,
    );
    expect(hoisted.warn).toHaveBeenCalledWith(
      expect.stringContaining("blank profile"),
      expect.objectContaining({
        projectId: "project-1",
        error: "browser profile download returned 404",
      }),
    );
  });

  it("hands a cancelled caller its own abort back", async () => {
    const controller = new AbortController();
    const aborted = new DOMException("aborted", "AbortError");
    hoisted.downloadProfile.mockImplementation(async () => {
      controller.abort();
      throw aborted;
    });
    const onNotice = vi.fn();

    await expect(
      downloadSavedProfileForLocalBoot({
        ...args,
        signal: controller.signal,
        onNotice,
      }),
    ).rejects.toBe(aborted);
    expect(onNotice).not.toHaveBeenCalled();
  });
});

describe("a local conversation browser's first boot", () => {
  async function boot(notices: string[]) {
    const built = buildBrowserTools({
      authHeader: "Bearer user",
      projectId: "project-1",
      engine: "local",
      approvalDelivery: { kind: "attested" },
      localConsentToken: "consent-token",
      sessionScope: { kind: "conversation", sessionId: "chat-a" },
      onBrowserNotice: (notice: string) => notices.push(notice),
    } as never);
    await built!.tools.browser_observe.execute!({}, {
      toolCallId: "call-1",
    } as never);
  }

  it("imports the saved profile when it loads", async () => {
    const notices: string[] = [];
    await boot(notices);

    expect(hoisted.ensureLocal).toHaveBeenCalledWith(
      expect.objectContaining({ profileArchive: ARCHIVE }),
    );
    expect(notices).toEqual([]);
  });

  it.each([
    [
      "the download fails",
      () =>
        hoisted.downloadProfile.mockRejectedValue(new Error("backend error")),
      SAVED_PROFILE_LOAD_FAILED_NOTICE,
    ],
    [
      "the server holds no service token",
      () => delete process.env.INSPECTOR_SERVICE_TOKEN,
      SAVED_PROFILE_UNAVAILABLE_NOTICE,
    ],
  ])(
    "still boots, blank, when %s",
    async (_label, arrange, expectedNotice) => {
      arrange();
      const notices: string[] = [];
      await boot(notices);

      expect(hoisted.ensureLocal).toHaveBeenCalledOnce();
      expect(hoisted.ensureLocal.mock.calls[0][0]).not.toHaveProperty(
        "profileArchive",
      );
      expect(hoisted.recordBoot).toHaveBeenCalled();
      expect(notices).toEqual([expectedNotice]);
    },
  );
});
