import { afterEach, describe, expect, it, vi } from "vitest";
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
} from "../harness-bake-observer.js";
import {
  HARNESS_BAKE_MANIFEST_PATH,
  HARNESS_BAKED_MARKER_AUTHOR,
} from "../harness-bake.js";

// The observer is what turns "did this turn hit the baked template?" into a
// log field the bake-miss monitor can read. It must classify every way a turn
// can bootstrap — including an install that never finished — and never change
// what the framework sees.

const ID = "0123456789abcdef";
const MARKER = `/home/user/.harness-bootstrap/claude-code/.bootstrap-${ID}.ok`;
const bakedMarker = JSON.stringify({
  bakedBy: HARNESS_BAKED_MARKER_AUTHOR,
  harnessId: "claude-code",
  identity: ID,
  bakeId: "abc123def456",
  versions: { "claude-code": "2.1.245", node: "24.20.0", pnpm: "12.8.1" },
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
  } = {},
) {
  const bootstrapDir = options.bootstrapDir ?? ".harness-bootstrap/claude-code";
  const session = options.resume
    ? await provider.resumeSession!({ sessionId: "s" })
    : await provider.createSession();
  const restricted = session.restricted();
  const marker = `${session.defaultWorkingDirectory}/${bootstrapDir}/.bootstrap-${ID}.ok`;
  const existing = await restricted.readTextFile({ path: marker });
  if (existing !== null) return;
  await restricted.writeTextFile({
    path: `${session.defaultWorkingDirectory}/${bootstrapDir}/package.json`,
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
      bakedVersions: "claude-code@2.1.245,node@24.20.0,pnpm@12.8.1",
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
    // Drift is a field the monitor groups by, not a log line of its own.
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

  it("classifies a custom working directory as an INTENTIONAL fallback", async () => {
    const fake = fakeProvider({
      cwd: "/home/user/project",
      files: { [HARNESS_BAKE_MANIFEST_PATH]: "{}" },
    });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed);
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "installed",
      expectation: "custom-workdir",
      bakeOnBox: "present",
      defaultWorkingDirectory: "/home/user/project",
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
