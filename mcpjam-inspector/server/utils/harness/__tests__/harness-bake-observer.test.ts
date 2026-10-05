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
  observeHarnessBootstrap,
} from "../harness-bake-observer.js";
import {
  HARNESS_BAKE_MANIFEST_PATH,
  HARNESS_BAKED_MARKER_AUTHOR,
} from "../harness-bake.js";

// The observer is what turns "did this turn hit the baked template?" into a
// log field the bake-miss alert can read. It must classify every way a turn
// can bootstrap — and never change what the framework sees.

const ID = "0123456789abcdef";
const bakedMarker = JSON.stringify({
  bakedBy: HARNESS_BAKED_MARKER_AUTHOR,
  harnessId: "claude-code",
  identity: ID,
  bakeId: "abc123def456",
  versions: { "claude-code": "2.1.245", node: "24.20.0", pnpm: "10.18.1" },
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

/** What the framework's `applyBootstrapRecipe` does, through the restricted view. */
async function frameworkBootstrap(
  provider: HarnessV1SandboxProvider,
  bootstrapDir = ".harness-bootstrap/claude-code",
  resume = false,
) {
  const session = resume
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
  await restricted.writeTextFile({ path: marker, content: "" });
}

afterEach(() => {
  logged.warn.mockClear();
});

describe("observeHarnessBootstrap", () => {
  it("reports a box the template baked, with what it baked", async () => {
    const fake = fakeProvider({
      files: {
        [`/home/user/.harness-bootstrap/claude-code/.bootstrap-${ID}.ok`]:
          bakedMarker,
      },
    });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed);
    const o = await harnessBootstrapObservation(observed);
    expect(o).toMatchObject({
      outcome: "baked",
      expectation: "baked",
      bakeOnBox: "not-checked",
      bootstrapDir: ".harness-bootstrap/claude-code",
      identity: ID,
      bakeId: "abc123def456",
      bakedVersions: "claude-code@2.1.245,node@24.20.0,pnpm@10.18.1",
    });
    // A hit costs nothing extra: no manifest probe.
    expect(fake.reads).not.toContain(HARNESS_BAKE_MANIFEST_PATH);
  });

  it("reports an install, and that the box carries a DIFFERENT bake (drift)", async () => {
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
    expect(logged.warn).toHaveBeenCalledWith(
      expect.stringContaining("[harness][bake-drift]"),
      expect.objectContaining({ harnessRecipeIdentity: ID }),
    );
  });

  it("reports an install on a box with no bake at all (old template / custom image) without crying drift", async () => {
    const fake = fakeProvider({ files: {} });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed);
    const o = await harnessBootstrapObservation(observed);
    expect(o).toMatchObject({
      outcome: "installed",
      expectation: "baked",
      bakeOnBox: "absent",
    });
    harnessBootstrapLogFields(o, "2.1.245");
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("reports a marker an EARLIER turn installed as reused, not baked", async () => {
    const fake = fakeProvider({
      files: {
        [`/home/user/.harness-bootstrap/claude-code/.bootstrap-${ID}.ok`]: "",
      },
    });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed, ".harness-bootstrap/claude-code", true);
    expect(await harnessBootstrapObservation(observed)).toMatchObject({
      outcome: "reused",
      expectation: "baked",
    });
  });

  it("classifies a custom working directory as an INTENTIONAL fallback", async () => {
    const fake = fakeProvider({
      cwd: "/home/user/project",
      files: { [HARNESS_BAKE_MANIFEST_PATH]: "{}" },
    });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed);
    const o = await harnessBootstrapObservation(observed);
    expect(o).toMatchObject({
      outcome: "installed",
      expectation: "custom-workdir",
      bakeOnBox: "present",
      defaultWorkingDirectory: "/home/user/project",
    });
    harnessBootstrapLogFields(o, undefined);
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("classifies a recipe the template does not bake as an intentional fallback", async () => {
    // Any bootstrap dir outside HARNESS_BAKED_BOOTSTRAP_DIRS — a harness added
    // without a bake, or an older recipe layout.
    const fake = fakeProvider({ files: {} });
    const observed = observeHarnessBootstrap(fake.provider);
    await frameworkBootstrap(observed, ".harness-bootstrap/not-baked");
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
