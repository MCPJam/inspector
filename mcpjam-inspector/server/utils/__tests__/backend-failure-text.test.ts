/**
 * MJ-020, MJ-021: the sentence a caller sees when MCPJam's own backend fails —
 * the backend's text locally, the route's own copy when hosted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ hosted: true }));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return config.hosted;
    },
  };
});

const { backendFailureText } = await import("../backend-failure-text.js");
const { resolveOrgModelConfig, resolveOrgProviderRuntimeForTarget } =
  await import("../org-model-config.js");
const { logger } = await import("../logger.js");

const BACKEND_TEXT =
  "Uncaught Error: UNEXPECTED_MARKER Not a member of this workspace at requireWorkspaceRole";

describe("backendFailureText", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers with the fallback in hosted mode and logs the text", () => {
    expect(
      backendFailureText({
        source: "test",
        status: 403,
        detail: BACKEND_TEXT,
        fallback: "Request failed.",
        hosted: true,
      }),
    ).toBe("Request failed.");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).toContain(
      "UNEXPECTED_MARKER",
    );
  });

  it("answers with the backend's text outside hosted mode", () => {
    expect(
      backendFailureText({
        source: "test",
        status: 403,
        detail: BACKEND_TEXT,
        fallback: "Request failed.",
        hosted: false,
      }),
    ).toBe(BACKEND_TEXT);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   ", { message: "not a string" }])(
    "falls back when the backend sent no usable text (%j)",
    (detail) => {
      expect(
        backendFailureText({
          source: "test",
          status: 500,
          detail,
          fallback: "Request failed.",
          hosted: false,
        }),
      ).toBe("Request failed.");
    },
  );
});

describe("org model config resolution failures", () => {
  beforeEach(() => {
    config.hosted = true;
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example/");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    [
      "a refused config lookup",
      () => Response.json({ ok: false, error: BACKEND_TEXT }, { status: 403 }),
      "Org model config resolution failed (403)",
    ],
    [
      "an unsuccessful config lookup",
      () => Response.json({ ok: false, error: BACKEND_TEXT }),
      "Failed to resolve org model config",
    ],
  ])("hosted: %s names no backend text", async (_label, answer, expected) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());

    await expect(
      resolveOrgModelConfig(
        { projectId: `project_hosted_${expected.length}` },
        { bearerToken: "user-token" },
      ),
    ).rejects.toThrow(expected);
  });

  it.each([
    [
      "a refused runtime lookup",
      () => Response.json({ ok: false, error: BACKEND_TEXT }, { status: 403 }),
      "Org runtime resolution failed (403)",
    ],
    [
      "an unsuccessful runtime lookup",
      () => Response.json({ ok: false, error: BACKEND_TEXT }),
      "Failed to resolve org provider runtime",
    ],
  ])("hosted: %s names no backend text", async (_label, answer, expected) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());

    const failure = await resolveOrgProviderRuntimeForTarget(
      { projectId: `project_runtime_${expected.length}` },
      "openai",
      "provider-model",
      { bearerToken: "user-token" },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(expected);
  });

  it("keeps the backend's text outside hosted mode", async () => {
    config.hosted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ ok: false, error: BACKEND_TEXT }, { status: 403 }),
    );

    await expect(
      resolveOrgModelConfig(
        { projectId: "project_local_backend_text" },
        { bearerToken: "user-token" },
      ),
    ).rejects.toThrow(BACKEND_TEXT);
  });
});
