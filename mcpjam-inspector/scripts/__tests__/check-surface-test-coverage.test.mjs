import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFeatureMap,
  checkFeatureMap,
} from "../check-surface-test-coverage.mjs";

const INSPECTOR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(INSPECTOR, "scripts", "check-surface-test-coverage.mjs");

function featureMap(overrides = {}) {
  const surface = (id, e2e, component) => ({
    id,
    route: `/${id}`,
    roots: [`client/src/components/${id}.tsx`],
    e2e,
    component,
  });
  return {
    surfaces: [
      surface("tools", ["e2e/tools.spec.ts"], []),
      surface("tracing", [], []),
    ],
    scanned: { e2eFiles: 1, componentFiles: 1, modules: 2 },
    unknownTags: [],
    ...overrides,
  };
}

test("check passes when every untested surface is baselined", () => {
  assert.deepEqual(checkFeatureMap(featureMap(), ["tracing"]), []);
});

test("check fails a new untested surface and says what to add", () => {
  const [problem, ...rest] = checkFeatureMap(featureMap(), []);
  assert.equal(rest.length, 0);
  assert.match(problem, /^tracing \(\/tracing\) has no test/);
  assert.match(problem, /navigates to \/tracing/);
  assert.match(problem, /client\/src\/components\/tracing\.tsx/);
  assert.match(problem, /@surface tracing/);
});

test("check fails a baselined surface that gained a test, and a stale entry", () => {
  const problems = checkFeatureMap(featureMap(), ["tracing", "tools", "gone"]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /tools now has 1 test\(s\).*--update-baseline/);
  assert.match(problems[1], /unknown surface "gone"/);
});

test("check fails when the derivation finds nothing to join", () => {
  const empty = featureMap({
    scanned: { e2eFiles: 0, componentFiles: 0, modules: 0 },
    unknownTags: ["e2e/x.spec.ts: @surface nope"],
  });
  empty.surfaces[0].roots = [];
  const problems = checkFeatureMap(empty, ["tracing"]).join("\n");
  assert.match(problems, /0 E2E specs/);
  assert.match(problems, /0 component tests/);
  assert.match(problems, /tools: no root component/);
  assert.match(
    problems,
    /unknown surface tag: e2e\/x\.spec\.ts: @surface nope/,
  );
});

test("a spec gets harness credit for navigating to it, not for naming it", () => {
  const files = {
    "shared/app-surfaces.ts": `export const APP_SURFACES = [
  { id: "oauth", canonicalPath: "/oauth", routePatterns: ["oauth"] },
] as const satisfies readonly AppSurfaceManifest[];`,
    "client/src/router.tsx": `import { OAuthTab } from "./components/OAuthTab";
const ROUTE_ELEMENTS = {
  oauth: { element: <OAuthTab /> },
};
const routes = [
  {
    path: "__e2e/oauth-debugger",
    lazy: async () => {
      const { Harness } = await import("./components/e2e/Harness");
      return { Component: Harness };
    },
  },
];`,
    "client/src/App.tsx": "export {};",
    "client/src/components/OAuthTab.tsx": "export function OAuthTab() {}",
    "client/src/components/e2e/Harness.tsx": `import { OAuthTab } from "../OAuthTab";`,
    "e2e/navigates.spec.ts": `await page.goto("/__e2e/oauth-debugger");`,
    "e2e/names.spec.ts": `const harnessPath = "/__e2e/oauth-debugger";
await page.goto("/");`,
  };
  const dir = mkdtempSync(join(tmpdir(), "mcpjam-surface-harness-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    const [oauth] = buildFeatureMap(dir).surfaces;
    assert.deepEqual(oauth.e2e, ["e2e/navigates.spec.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real tree passes --check, and --update-baseline only removes entries", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /surface-test-coverage: ok/);

  const dir = mkdtempSync(join(tmpdir(), "mcpjam-surface-baseline-"));
  try {
    const baseline = join(dir, "baseline.json");
    // `tools` has tests and `gone` is no surface; both must go, nothing added.
    writeFileSync(baseline, JSON.stringify({ uncovered: ["tools", "gone"] }));
    const update = spawnSync(
      process.execPath,
      [SCRIPT, "--update-baseline", "--baseline", baseline],
      { encoding: "utf8" },
    );
    assert.equal(update.status, 0, update.stderr);
    assert.deepEqual(JSON.parse(readFileSync(baseline, "utf8")), {
      uncovered: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
