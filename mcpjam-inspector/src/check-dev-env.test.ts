import { describe, it, expect } from "vitest";
import { evaluateDevEnv, TASKS } from "../scripts/check-dev-env.mjs";

/**
 * The severity table is the whole point of this guard, so it is what gets
 * pinned. One rule governs it: only the packaging path may hard-fail; the dev
 * path only ever warns. A future edit that promotes a dev warning to an error
 * turns this guard into the thing it was written to prevent -- a silent,
 * mysterious block on someone's `electron:dev`.
 */

const PINNED = "24.14.0";
const ENGINES = ">=22.0.0";

/** A healthy baseline: nothing to report on any task. */
function base(overrides: Record<string, unknown> = {}) {
  return {
    task: "dev",
    nodeVersion: "v24.14.0",
    platform: "darwin",
    nvmrcVersion: `${PINNED}\n`,
    enginesNodeRange: ENGINES,
    ...overrides,
  };
}

const codes = (findings: Array<{ code: string }>) =>
  findings.map((f) => f.code);

const DEV_TASKS = ["dev", "electron-dev"] as const;
const PACKAGING_TASKS = ["electron-package", "electron-make"] as const;

describe("evaluateDevEnv", () => {
  it("reports nothing for a healthy environment on every task", () => {
    for (const task of TASKS) {
      const { errors, warnings } = evaluateDevEnv(base({ task }));
      expect({ task, errors, warnings }).toEqual({
        task,
        errors: [],
        warnings: [],
      });
    }
  });

  it("rejects an unknown task rather than silently passing it", () => {
    expect(() => evaluateDevEnv(base({ task: "publish" }))).toThrow(
      /Unknown task/,
    );
  });

  describe("Node newer than .nvmrc", () => {
    const tooNew = { nodeVersion: "v26.3.0" };

    it.each(DEV_TASKS)("only warns on %s", (task) => {
      const { errors, warnings } = evaluateDevEnv(base({ task, ...tooNew }));
      expect(codes(errors)).toEqual([]);
      expect(codes(warnings)).toEqual(["node-too-new"]);
    });

    it.each(PACKAGING_TASKS)("is fatal on %s", (task) => {
      const { errors, warnings } = evaluateDevEnv(base({ task, ...tooNew }));
      expect(codes(errors)).toEqual(["node-too-new"]);
      expect(codes(warnings)).toEqual([]);
    });

    it("names the pinned version in the fix so it can be pasted", () => {
      const { errors } = evaluateDevEnv(
        base({ task: "electron-make", ...tooNew }),
      );
      expect(errors[0]!.fix).toContain(`nvm install ${PINNED}`);
      // The Homebrew trap is the part people lose an afternoon to.
      expect(errors[0]!.fix).toMatch(/Homebrew/);
    });

    it("explains that packaging exits 0 while producing nothing", () => {
      const { errors } = evaluateDevEnv(
        base({ task: "electron-make", ...tooNew }),
      );
      expect(errors[0]!.message).toMatch(/exits 0/);
    });

    it("is suppressed by MCPJAM_ALLOW_UNSUPPORTED_NODE", () => {
      const { errors, warnings } = evaluateDevEnv(
        base({ task: "electron-make", ...tooNew, allowUnsupportedNode: true }),
      );
      expect([...codes(errors), ...codes(warnings)]).toEqual([]);
    });

    it("enforces no upper bound when .nvmrc is unreadable", () => {
      const { errors, warnings } = evaluateDevEnv(
        base({ task: "electron-make", ...tooNew, nvmrcVersion: undefined }),
      );
      expect([...codes(errors), ...codes(warnings)]).toEqual([]);
    });
  });

  describe("Node below the engines floor", () => {
    const tooOld = { nodeVersion: "v20.11.0" };

    it.each(DEV_TASKS)("only warns on %s", (task) => {
      const { errors, warnings } = evaluateDevEnv(base({ task, ...tooOld }));
      expect(codes(errors)).toEqual([]);
      expect(codes(warnings)).toEqual(["node-too-old"]);
    });

    it.each(PACKAGING_TASKS)("is fatal on %s", (task) => {
      const { errors } = evaluateDevEnv(base({ task, ...tooOld }));
      expect(codes(errors)).toEqual(["node-too-old"]);
    });

    it("is suppressed by MCPJAM_ALLOW_UNSUPPORTED_NODE", () => {
      const { errors, warnings } = evaluateDevEnv(
        base({
          task: "electron-package",
          ...tooOld,
          allowUnsupportedNode: true,
        }),
      );
      expect([...codes(errors), ...codes(warnings)]).toEqual([]);
    });
  });

  describe("DMG native addons", () => {
    const broken = {
      dmgAddons: [
        { name: "macos-alias", ok: false, reason: "invalid ELF header" },
        { name: "fs-xattr", ok: true },
      ],
    };

    it("is fatal on electron-make on darwin, once per unusable addon", () => {
      const { errors } = evaluateDevEnv(
        base({ task: "electron-make", platform: "darwin", ...broken }),
      );
      expect(codes(errors)).toEqual(["dmg-addon-unusable"]);
      expect(errors[0]!.message).toContain("macos-alias");
      // An ABI mismatch is why the probe is a real require(), not an existence
      // check -- keep the reason in the message or that distinction is lost.
      expect(errors[0]!.message).toContain("invalid ELF header");
      expect(errors[0]!.fix).toContain("electron:fix:dmg-deps");
    });

    it("does not run on electron-package (no DMG maker involved)", () => {
      const { errors, warnings } = evaluateDevEnv(
        base({ task: "electron-package", platform: "darwin", ...broken }),
      );
      expect([...codes(errors), ...codes(warnings)]).toEqual([]);
    });

    it.each(["win32", "linux"])("does not run on %s", (platform) => {
      const { errors, warnings } = evaluateDevEnv(
        base({ task: "electron-make", platform, ...broken }),
      );
      expect([...codes(errors), ...codes(warnings)]).toEqual([]);
    });

    it("is suppressed by MCPJAM_SKIP_DMG_CHECK", () => {
      const { errors } = evaluateDevEnv(
        base({
          task: "electron-make",
          platform: "darwin",
          ...broken,
          skipDmgCheck: true,
        }),
      );
      expect(codes(errors)).toEqual([]);
    });
  });

  describe("packaged build inputs", () => {
    const missing = {
      buildOutputs: [
        { label: "dist/client", exists: false },
        { label: "../sdk/dist", exists: true },
      ],
    };

    it.each(PACKAGING_TASKS)("is fatal on %s", (task) => {
      const { errors } = evaluateDevEnv(base({ task, ...missing }));
      expect(codes(errors)).toEqual(["build-output-missing"]);
      expect(errors[0]!.message).toContain("dist/client");
      expect(errors[0]!.fix).toContain("npm run build");
    });

    it.each(DEV_TASKS)("is not checked on %s", (task) => {
      const { errors, warnings } = evaluateDevEnv(base({ task, ...missing }));
      expect([...codes(errors), ...codes(warnings)]).toEqual([]);
    });
  });

  describe("dev-only conveniences", () => {
    it.each(DEV_TASKS)("warns about a busy port on %s", (task) => {
      const { errors, warnings } = evaluateDevEnv(
        base({ task, portInUse: true }),
      );
      expect(codes(errors)).toEqual([]);
      expect(codes(warnings)).toEqual(["port-busy"]);
      expect(warnings[0]!.message).toContain("6274");
    });

    it.each(DEV_TASKS)(
      "warns about a missing .env.development on %s",
      (task) => {
        const { warnings } = evaluateDevEnv(
          base({ task, envDevelopmentMissing: true }),
        );
        expect(codes(warnings)).toEqual(["env-development-missing"]);
        expect(warnings[0]!.fix).toContain(".env.development");
      },
    );

    it.each(PACKAGING_TASKS)("ignores both on %s", (task) => {
      const { errors, warnings } = evaluateDevEnv(
        base({ task, portInUse: true, envDevelopmentMissing: true }),
      );
      expect([...codes(errors), ...codes(warnings)]).toEqual([]);
    });
  });

  it("never produces an error on a dev task, whatever is wrong", () => {
    // The governing rule, asserted directly: everything broken at once.
    for (const task of DEV_TASKS) {
      const { errors } = evaluateDevEnv(
        base({
          task,
          nodeVersion: "v26.3.0",
          platform: "darwin",
          dmgAddons: [{ name: "macos-alias", ok: false }],
          buildOutputs: [{ label: "dist/client", exists: false }],
          portInUse: true,
          envDevelopmentMissing: true,
        }),
      );
      expect({ task, errors }).toEqual({ task, errors: [] });
    }
  });

  it("emits only ASCII, so Windows CI logs stay readable", () => {
    const { errors, warnings } = evaluateDevEnv(
      base({
        task: "electron-make",
        nodeVersion: "v26.3.0",
        platform: "darwin",
        dmgAddons: [{ name: "macos-alias", ok: false, reason: "boom" }],
        buildOutputs: [{ label: "dist/client", exists: false }],
      }),
    );
    for (const finding of [...errors, ...warnings]) {
      expect(`${finding.message}${finding.fix}`).toMatch(/^[\x20-\x7E\n]*$/);
    }
  });
});
