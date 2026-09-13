/**
 * Every place that names the pinned browser has to name the same one.
 *
 * A Chromium bump in this repository is a bump of a FACT BASE — which feature
 * flags suffice, whether annotations survive a round trip, whether
 * `toolsRemoved` fires on navigation, whether a `_blank` navigation loses the
 * page's tools — and each of those facts is written as prose beside the code
 * it justifies, naming a version. Nothing connected those sentences to the
 * dependency that decides which browser actually runs, so `package.json` could
 * move and nine paragraphs would quietly start describing a browser nobody was
 * using.
 *
 * This walks them. When it fails after a deliberate bump, the fix is
 * `docs/chromium-bump-checklist.md`, not a looser assertion here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  PINNED_CHROMIUM,
  PINNED_CHROMIUM_MAJOR,
  PINNED_PLAYWRIGHT,
} from "../pinned-chromium";
import { chromiumMajorFromManifest } from "../../browserd/daemon/launch-args";

/** `mcpjam-inspector/` — the inspector app. */
const APP = resolve(__dirname, "..", "..", "..", "..");
/** The workspace root, where the CI workflows live. */
const ROOT = resolve(APP, "..");

const read = (path: string) => readFileSync(path, "utf8");

describe("the Playwright pin", () => {
  it("is the version package.json installs, in both entries", () => {
    const manifest = JSON.parse(read(join(APP, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pins = { ...manifest.dependencies, ...manifest.devDependencies };
    // EXACT, not a range: a caret here would let a patch bump change the
    // browser under a fact base that was measured against one build.
    expect(pins["playwright"]).toBe(PINNED_PLAYWRIGHT);
    expect(pins["@playwright/test"]).toBe(PINNED_PLAYWRIGHT);
  });

  it("is the image every CI job runs in", () => {
    // CI is where the spikes actually execute. An image one release behind
    // runs them against a different browser than the one the prose describes,
    // and a finding measured on a version nobody ships is worse than none.
    for (const workflow of ["test.yml", "post-deploy-smoke.yml"]) {
      const source = read(join(ROOT, ".github/workflows", workflow));
      const images = [
        ...source.matchAll(/mcr\.microsoft\.com\/playwright:v([0-9.]+)/g),
      ].map((match) => match[1]);
      // AT LEAST ONE, before checking that they all agree. A `for` over an
      // empty list passes, so a workflow that renamed or parameterised its
      // image would quietly stop being checked at all — the pin would still
      // be green while nothing enforced it.
      expect(
        images.length,
        `${workflow} must run a pinned Playwright image`,
      ).toBeGreaterThan(0);
      // Not `toContain`: EVERY job has to agree, and a single stale one is
      // exactly the drift this test exists to catch.
      for (const version of images) {
        expect(version, `${workflow} runs a Playwright image`).toBe(
          PINNED_PLAYWRIGHT,
        );
      }
    }
  });
});

describe("the Chromium pin", () => {
  it("is the build the installed Playwright actually ships", () => {
    // The authority on which browser runs is playwright-core's own
    // `browsers.json` — the file that decides which build gets installed —
    // which is why `bundledChromiumMajorVersion` reads it rather than a
    // constant. If this fails, the constant is a wish and the browser is
    // something else.
    const require_ = createRequire(import.meta.url);
    const root = dirname(require_.resolve("playwright-core/package.json"));
    const major = chromiumMajorFromManifest(read(join(root, "browsers.json")));
    expect(major).toBe(PINNED_CHROMIUM_MAJOR);
  });

  it("is the version every prose mention names", () => {
    // Each of these sentences is a measured finding about THIS browser. The
    // list is explicit rather than a repo-wide grep so that adding a mention
    // is a deliberate edit here — and so that a historical document (a dated
    // security audit, a recorded benchmark) is not forced to lie about the
    // browser it was actually run against.
    const mentions = [
      "server/services/webmcp-inspector/launch-args.ts",
      "server/services/browserd/daemon/launch-args.ts",
      "server/services/webmcp-inspector/__tests__/webmcp-cdp.spike.test.ts",
      "server/services/browserd/daemon/__tests__/launch-args.test.ts",
      "shared/webmcp-inspector-protocol.ts",
      "docs/webmcp-inspector.md",
      "client/src/lib/__tests__/tool-form.webmcp-declarative.test.ts",
    ];
    for (const path of mentions) {
      const source = read(join(APP, path));
      expect(
        source.includes(PINNED_CHROMIUM),
        `${path} should name the pinned Chromium ${PINNED_CHROMIUM}`,
      ).toBe(true);
      // And must not name a DIFFERENT build, which is how half a file gets
      // bumped and the other half does not.
      //
      // `<major>.0.0.0` is excluded on purpose: that is the ZEROED form Chrome
      // puts in its own User-Agent string, and `launch-args.ts` quotes it
      // three times while explaining the UA correction. It is not a build
      // number and bumping it to a real one would make those sentences wrong.
      const others = [...source.matchAll(/\b\d+\.\d+\.\d+\.\d+\b/g)]
        .map((match) => match[0])
        .filter(
          (version) =>
            version !== PINNED_CHROMIUM &&
            version !== PINNED_PLAYWRIGHT &&
            !/^\d+\.0\.0\.0$/.test(version),
        );
      expect(others, `${path} names a stale Chromium build`).toEqual([]);
    }
  });

  it("is the version the prose mentions name for Playwright too", () => {
    for (const path of [
      "server/services/webmcp-inspector/launch-args.ts",
      "server/services/browserd/daemon/launch-args.ts",
      "server/services/webmcp-inspector/__tests__/webmcp-cdp.spike.test.ts",
    ]) {
      const source = read(join(APP, path));
      expect(
        source.includes(PINNED_PLAYWRIGHT),
        `${path} should name Playwright ${PINNED_PLAYWRIGHT}`,
      ).toBe(true);
    }
  });
});

describe("the bump checklist", () => {
  it("exists, and names every site this test walks", () => {
    // The test says WHAT is out of step; the checklist says what to do about
    // it. A failure with no checklist is a puzzle.
    const checklist = read(join(APP, "docs/chromium-bump-checklist.md"));
    for (const site of [
      "package.json",
      ".github/workflows/test.yml",
      "pinned-chromium.ts",
      "webmcp-cdp.spike.test.ts",
      "src/main.ts",
      "bundle:browserd",
    ]) {
      expect(checklist, `the checklist should mention ${site}`).toContain(site);
    }
  });
});
