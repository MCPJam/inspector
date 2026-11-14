import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";

const logged = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: {
    warn: logged.warn,
    info: logged.info,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  harnessBootstrapLogFields,
  harnessBootstrapObservation,
  logHarnessBootstrapOnFailure,
  observeHarnessBootstrap,
  resetHarnessBakeStaleWarningsForTests,
  watchNewBoxForStaleBake,
} from "../harness-bake-observer.js";
import {
  HARNESS_BAKE_MANIFEST_PATH,
  HARNESS_BAKED_MARKER_AUTHOR,
} from "../harness-bake.js";
import { buildLegacyLogRow } from "@/shared/strict-log";

// The observer is what turns "did this turn hit the baked template?" into a
// log field the bake-miss monitor can read. It must classify every way a turn
// can bootstrap — including an install that never finished — and never change
// what the framework sees.

const ID = "0123456789abcdef";
const MARKER = `/home/user/.ai-sdk-harness/.harness-bootstrap/claude-code/.bootstrap-${ID}.ok`;
const bakedMarker = JSON.stringify({
  bakedBy: HARNESS_BAKED_MARKER_AUTHOR,
  harnessId: "claude-code",
  identity: ID,
  bakeId: "abc123def456",
  versions: { "claude-code": "2.1.245", node: "24.22.1", pnpm: "12.8.1" },
});

function fakeProvider(opts: { cwd?: string; files: Record<string, string> }) {
  const files = { ...opts.files };
  const reads: string[] = [];
  const session = {
    id: "box",
    defaultWorkingDirectory: opts.cwd ?? "/home/user",
    readTextFile: vi.fn(
      async ({ path }: { path: string }): Promise<string | null> => {
        reads.push(path);
        return files[path] ?? null;
      },
    ),
    writeTextFile: vi.fn(
      async ({ path, content }: { path: string; content: string }) => {
        files[path] = content;
      },
    ),
    run: vi.fn(),
    restricted: () => session,
  };
  const provider = {
    specificationVersion: "harness-sandbox-v1",
    providerId: "fake",
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
  } as unknown as HarnessV1SandboxProvider;
  return { provider, session, reads, files };
}

/**
 * What the framework's `applyBootstrapRecipe` does, through the restricted
 * view: read the marker, and on a miss write the recipe, run its install, and
 * write the marker only when the install succeeded.
 */
async function frameworkBootstrap(
  provider: HarnessV1SandboxProvider,
  options: {
    bootstrapDir?: string;
    resume?: boolean;
    installFails?: boolean;
    identity?: string;
  } = {},
) {
  const bootstrapDir = options.bootstrapDir ?? ".harness-bootstrap/claude-code";
  const session = options.resume
    ? await provider.resumeSession!({ sessionId: "s" })
    : await provider.createSession();
  const restricted = session.restricted();
  const home = "/home/user";
  const marker = `${home}/.ai-sdk-harness/${bootstrapDir}/.bootstrap-${options.identity ?? ID}.ok`;
  const existing = await restricted.readTextFile({ path: marker });
  if (existing !== null) return;
  await restricted.writeTextFile({
    path: `${home}/.ai-sdk-harness/${bootstrapDir}/package.json`,
    content: "{}",
  });
  if (options.installFails) {
    throw new Error("pnpm install exited 1");
  }
  await restricted.writeTextFile({ path: marker, content: "" });
}

afterEach(() => {
  logged.warn.mockClear();
  logged.info.mockClear();
});

describe("observeHarnessBootstrap", () => {
  it("reports a box the template baked, with what it baked", async () => {
    const fake = fakeProvider({ files: { [MARKER]: bakedMarker } });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed);
    const o = await harnessBootstrapObservation(observed);
    expect(o).toMatchObject({
      outcome: "baked",
      expectation: "baked",
      // The template's own marker is proof of the bake.
      bakeOnBox: "present",
      bootstrapDir: ".harness-bootstrap/claude-code",
      identity: ID,
      bakeId: "abc123def456",
      bakedVersions: "claude-code@2.1.245,node@24.22.1,pnpm@12.8.1",
    });
    // A hit costs nothing extra: no manifest probe.
    expect(fake.reads).not.toContain(HARNESS_BAKE_MANIFEST_PATH);
  });

  it("reports an install on a box that carries a DIFFERENT bake (drift)", async () => {
    const fake = fakeProvider({
      files: { [HARNESS_BAKE_MANIFEST_PATH]: "{}" },
    });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed);
    const o = await harnessBootstrapObservation(observed);
    expect(o).toMatchObject({
      outcome: "installed",
      expectation: "baked",
      bakeOnBox: "present",
    });

    const fields = harnessBootstrapLogFields(o, "2.1.245");
    expect(fields.text).toContain(
      " bootstrap=installed bakeExpected=baked bakeOnBox=present",
    );
    expect(fields.text).toContain(
      `recipe=.harness-bootstrap/claude-code@${ID}`,
    );
    expect(fields.text).toContain("runtimePinned=2.1.245");
    expect(fields.context).toMatchObject({
      harnessBootstrap: "installed",
      harnessBakeExpected: "baked",
      harnessBakeOnBox: "present",
      harnessRecipeIdentity: ID,
    });
    // Drift is a field the monitor groups by, not a log line of its own,
    // unless the caller marked the box new (watchNewBoxForStaleBake below).
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("reports an install on a box with no bake at all (old template / custom image)", async () => {
    const fake = fakeProvider({ files: {} });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed);
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "installed",
      expectation: "baked",
      bakeOnBox: "absent",
    });
  });

  it("reports an install that never finished as install-failed", async () => {
    // The pnpm 11 and deny-all-egress outages: the marker was missing, the
    // recipe was written, the install failed, and no marker ever appeared.
    const fake = fakeProvider({ files: {} });
    const observed = observeHarnessBootstrap(fake.provider);
    await expect(
      frameworkBootstrap(observed, { installFails: true }),
    ).rejects.toThrow(/pnpm install/);
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "install-failed",
      expectation: "baked",
      bakeOnBox: "absent",
      identity: ID,
    });
  });

  it("reports a marker an EARLIER turn installed as reused, and checks the box for a bake", async () => {
    const fake = fakeProvider({ files: { [MARKER]: "" } });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed, { resume: true });
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "reused",
      expectation: "baked",
      bakeOnBox: "absent",
    });
    expect(fake.reads).toContain(HARNESS_BAKE_MANIFEST_PATH);
  });

  it("a custom working directory still hits the HOME bake", async () => {
    const fake = fakeProvider({
      cwd: "/home/user/project",
      files: { [HARNESS_BAKE_MANIFEST_PATH]: "{}" },
    });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed);
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "installed",
      expectation: "baked",
      bakeOnBox: "present",
      defaultWorkingDirectory: "/home/user/project",
    });
  });

  it("classifies a marker under a different HOME as custom-workdir", async () => {
    const otherHome = "/home/user/project";
    const marker = `${otherHome}/.ai-sdk-harness/.harness-bootstrap/claude-code/.bootstrap-${ID}.ok`;
    const fake = fakeProvider({ cwd: otherHome, files: {} });
    const observed = observeHarnessBootstrap(fake.provider);
    const session = await observed.createSession();
    await session.restricted().writeTextFile({ path: marker, content: "" });
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "installed",
      expectation: "custom-workdir",
    });
  });

  it("classifies a recipe the template does not bake as an intentional fallback", async () => {
    // Any bootstrap dir outside HARNESS_BAKED_BOOTSTRAP_DIRS — a harness added
    // without a bake, or an older recipe layout.
    const fake = fakeProvider({ files: {} });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed, {
      bootstrapDir: ".harness-bootstrap/not-baked",
    });
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "installed",
      expectation: "unbaked-recipe",
    });
  });

  it("forwards every call unchanged", async () => {
    const fake = fakeProvider({ files: { "/home/user/a": "A" } });
    const observed = observeHarnessBootstrap(fake.provider);
    const session = await observed.createSession();
    await expect(session.readTextFile({ path: "/home/user/a" })).resolves.toBe(
      "A",
    );
    await session.writeTextFile({ path: "/home/user/b", content: "B" });
    expect(fake.files["/home/user/b"]).toBe("B");
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "none",
      expectation: "none",
      bakeOnBox: "not-checked",
    });
  });

  it("answers nothing for a provider it did not wrap (the local path)", async () => {
    expect(await harnessBootstrapObservation({})).toBeUndefined();
    expect(harnessBootstrapLogFields(undefined, "1")).toEqual({
      text: "",
      context: {},
    });
  });

  it("does not let a wedged manifest probe hold the log line", async () => {
    const fake = fakeProvider({ files: {} });
    fake.session.readTextFile.mockImplementation(
      async ({ path }: { path: string }) =>
        path === HARNESS_BAKE_MANIFEST_PATH
          ? new Promise<string | null>(() => {})
          : null,
    );
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed);
    const o = await harnessBootstrapObservation(observed, 10);
    expect(o?.bakeOnBox).toBe("unknown");
  });
});

describe("watchNewBoxForStaleBake", () => {
  // The alert for a deployment whose template lacks this inspector's recipes.
  // A box from the computer template carries its bake manifest; one from a
  // custom environment image does not.
  const STALE = "[harness][bake] harness_bake_stale";
  const templateBox = () =>
    fakeProvider({ files: { [HARNESS_BAKE_MANIFEST_PATH]: "{}" } });

  beforeEach(() => resetHarnessBakeStaleWarningsForTests());

  async function newBoxTurn(
    fake: ReturnType<typeof fakeProvider>,
    options: Parameters<typeof frameworkBootstrap>[1] = {},
    harnessId = "claude-code",
  ) {
    const observed = observeHarnessBootstrap(fake.provider);
    watchNewBoxForStaleBake(observed, harnessId);
    await frameworkBootstrap(observed, options);
    // Settles the manifest probe the warning waits on.
    return harnessBootstrapObservation(observed);
  }

  it("warns once per identity when a new box from the default template misses the bake", async () => {
    expect(await newBoxTurn(templateBox())).toMatchObject({
      outcome: "installed",
      bakeOnBox: "present",
    });
    await newBoxTurn(templateBox());
    expect(logged.warn).toHaveBeenCalledTimes(1);
    // The harness and the identity it expected, nothing else.
    expect(logged.warn).toHaveBeenCalledWith(STALE, {
      harnessId: "claude-code",
      harnessRecipeIdentity: ID,
    });

    const codex = "fedcba9876543210";
    await newBoxTurn(
      templateBox(),
      { bootstrapDir: ".harness-bootstrap/codex-appserver", identity: codex },
      "codex",
    );
    expect(logged.warn).toHaveBeenCalledTimes(2);
    expect(logged.warn).toHaveBeenLastCalledWith(STALE, {
      harnessId: "codex",
      harnessRecipeIdentity: codex,
    });
  });

  it("leaves a log row an alert can match after the strict log boundary", async () => {
    await newBoxTurn(templateBox());
    // The row `logger.warn` ingests: only catalogued messages and enumerated
    // fields survive it, so a message built at runtime would read log.unknown.
    const [message, context] = logged.warn.mock.lastCall ?? [];
    const row = buildLegacyLogRow(message, { ...context, level: "warn" });
    expect(row).toMatchObject({
      event: expect.stringMatching(/^log\.[0-9a-f]{16}$/),
      message: STALE,
      level: "warn",
      harnessId: "claude-code",
    });
  });

  it("warns when the new box's install then fails too: the miss is the evidence", async () => {
    const observed = observeHarnessBootstrap(templateBox().provider);
    watchNewBoxForStaleBake(observed, "claude-code");
    await expect(
      frameworkBootstrap(observed, { installFails: true }),
    ).rejects.toThrow(/pnpm install/);
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "install-failed",
      bakeOnBox: "present",
    });
    expect(logged.warn).toHaveBeenCalledWith(STALE, expect.anything());
  });

  it("stays silent on a new box from a custom environment image, which carries no bake", async () => {
    expect(await newBoxTurn(fakeProvider({ files: {} }))).toMatchObject({
      outcome: "installed",
      bakeOnBox: "absent",
    });
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("stays silent on a new box the template baked for this inspector", async () => {
    const fake = fakeProvider({ files: { [MARKER]: bakedMarker } });
    expect(await newBoxTurn(fake)).toMatchObject({ outcome: "baked" });
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("stays silent on a box not marked new, which can predate the template", async () => {
    // A follow-up turn's box, or a persistent computer.
    const observed = observeHarnessBootstrap(templateBox().provider);
    await frameworkBootstrap(observed, { resume: true });
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "installed",
      bakeOnBox: "present",
    });
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("stays silent on intentional fallbacks and when the box cannot say it carries a bake", async () => {
    await newBoxTurn(templateBox(), {
      bootstrapDir: ".harness-bootstrap/not-baked",
    });
    const otherHome = templateBox();
    const observed = observeHarnessBootstrap(otherHome.provider);
    watchNewBoxForStaleBake(observed, "claude-code");
    const session = await observed.createSession();
    await session.restricted().readTextFile({
      path: `/home/user/project/.ai-sdk-harness/.harness-bootstrap/claude-code/.bootstrap-${ID}.ok`,
    });
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      expectation: "custom-workdir",
      bakeOnBox: "present",
    });
    const unreachable = templateBox();
    unreachable.session.readTextFile.mockImplementation(
      async ({ path }: { path: string }) => {
        if (path === HARNESS_BAKE_MANIFEST_PATH) throw new Error("box gone");
        return null;
      },
    );
    expect(await newBoxTurn(unreachable)).toMatchObject({
      bakeOnBox: "unknown",
    });
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("ignores a provider it did not observe", () => {
    expect(() =>
      watchNewBoxForStaleBake(fakeProvider({ files: {} }).provider, "codex"),
    ).not.toThrow();
  });
});

describe("logHarnessBootstrapOnFailure", () => {
  it("reports a failed turn's install so the bake-miss monitor counts it", async () => {
    const fake = fakeProvider({
      files: { [HARNESS_BAKE_MANIFEST_PATH]: "{}" },
    });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed, { installFails: true }).catch(() => {});
    await logHarnessBootstrapOnFailure(observed, "2.1.245", "claude-code");
    expect(logged.info).toHaveBeenCalledTimes(1);
    expect(logged.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[harness\]\[bootstrap\] turn=failed bootstrap=install-failed bakeExpected=baked bakeOnBox=present/,
      ),
      expect.objectContaining({
        harnessTurn: "failed",
        harnessBootstrap: "install-failed",
        harnessBakeExpected: "baked",
        harnessBakeOnBox: "present",
        harnessRecipeIdentity: ID,
        harnessRuntimePinned: "2.1.245",
        // Groups with the turn's `[harness] turn failed` line per harness.
        harnessId: "claude-code",
      }),
    );
  });

  it("stays silent when the turn failed before any bootstrap, or off the cloud path", async () => {
    const fake = fakeProvider({ files: {} });
    const observed = observeHarnessBootstrap(fake.provider);
    await logHarnessBootstrapOnFailure(observed, "2.1.245");
    await logHarnessBootstrapOnFailure(null, "2.1.245");
    await logHarnessBootstrapOnFailure({}, "2.1.245");
    expect(logged.info).not.toHaveBeenCalled();
  });
});
