import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFeatureMap } from "../check-surface-test-coverage.mjs";
import {
  destinationSegments,
  harnessModules,
  matchSurface,
  moduleOwners,
  navigatedSurfaces,
  parseSurfaces,
  surfaceRoots,
  surfaceTags,
} from "../lib/surface-test-map.mjs";

const INSPECTOR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(INSPECTOR, "scripts", "check-surface-test-coverage.mjs");

const SURFACES = [
  { id: "home", canonicalPath: "/home", routePatterns: ["/", "home"] },
  { id: "tools", canonicalPath: "/tools", routePatterns: ["tools"] },
  {
    id: "scenarios",
    canonicalPath: "/user-testing",
    routePatterns: [
      "user-testing",
      "user-testing/new",
      "user-testing/:scenarioId",
    ],
  },
  {
    id: "swarms",
    canonicalPath: "/swarms",
    routePatterns: ["swarms", "swarms/new"],
  },
  {
    id: "support",
    canonicalPath: "/settings/support",
    routePatterns: ["settings/support"],
  },
  { id: "settings", canonicalPath: "/settings", routePatterns: ["settings"] },
];

test("the real manifest parses into every surface with its canonical route", () => {
  const source = readFileSync(
    join(INSPECTOR, "shared/app-surfaces.ts"),
    "utf8",
  );
  const surfaces = parseSurfaces(source);
  const declared = source.match(/^ {4}id: "/gm).length;
  assert.equal(surfaces.length, declared);
  assert.ok(surfaces.length >= 30, `parsed only ${surfaces.length} surfaces`);
  assert.equal(new Set(surfaces.map((s) => s.id)).size, surfaces.length);
  for (const surface of surfaces) {
    // The manifest contract: canonicalPath is one of the surface's own
    // patterns. A parse that drops or shifts an array entry breaks it.
    assert.ok(
      surface.routePatterns.includes(surface.canonicalPath.replace(/^\//, "")),
      `${surface.id}: ${surface.canonicalPath} not in ${surface.routePatterns}`,
    );
  }
});

test("comments with brackets and quotes do not bend the manifest parse", () => {
  const surfaces = parseSurfaces(`
export const APP_SURFACES = [
  {
    id: "a",
    // a note with ] and { and "quotes" and don't
    canonicalPath: "/a",
    routePatterns: ["a", "a/:x"], /* ] } */
    agentTools: { kind: "none", reason: "has [brackets] and {braces}" },
  },
  { id: "b", canonicalPath: "/b", routePatterns: ["b"] },
] as const satisfies readonly AppSurfaceManifest[];`);
  assert.deepEqual(surfaces, [
    { id: "a", canonicalPath: "/a", routePatterns: ["a", "a/:x"] },
    { id: "b", canonicalPath: "/b", routePatterns: ["b"] },
  ]);
});

test("destinations drop the project prefix, query and hash, and ignore the root", () => {
  assert.deepEqual(destinationSegments("/p/abc123/tools?x=1#y"), ["tools"]);
  assert.deepEqual(destinationSegments("/settings/support"), [
    "settings",
    "support",
  ]);
  assert.deepEqual(destinationSegments(":*/login"), ["login"]);
  assert.equal(destinationSegments("/"), null);
  assert.equal(destinationSegments("/?privacy=strict"), null);
  assert.equal(destinationSegments("/p/abc123"), null);
  assert.equal(destinationSegments("http://pane.test/tools"), null);
  assert.equal(destinationSegments(""), null);
});

test("a static route beats a :param route, and an interpolated tail matches its stem", () => {
  assert.equal(matchSurface(SURFACES, ["user-testing", "new"]), "scenarios");
  assert.equal(matchSurface(SURFACES, ["user-testing", ":*"]), "scenarios");
  assert.equal(matchSurface(SURFACES, ["swarms:*"]), "swarms");
  assert.equal(matchSurface(SURFACES, ["settings", "support"]), "support");
  assert.equal(matchSurface(SURFACES, [":*"]), null);
  assert.equal(matchSurface(SURFACES, ["nope"]), null);
});

test("a literal goto links its surface; other strings in the spec do not", () => {
  const spec = `
    test("x", async ({ page }) => {
      await page.goto(\`/p/\${PROJECT_ID}/tools\`);
      await expect(page).toHaveURL(/"settings"/);
      await page.getByRole("tab", { name: "settings" }).click();
      await page.goto("/");
    });`;
  assert.deepEqual([...navigatedSurfaces(spec, SURFACES)], ["tools"]);
});

test("a goto built from data links the route-shaped literals it loops over", () => {
  const spec = `
    const screens = { "overview": "home", "result": "tools", "run": \`user-testing/\${ID}\` };
    for (const [screen, route] of Object.entries(screens)) {
      test(screen, async ({ page }) => {
        await page.goto(\`/p/\${PROJECT_ID}/\${route}\`);
      });
    }`;
  assert.deepEqual([...navigatedSurfaces(spec, SURFACES)].sort(), [
    "home",
    "scenarios",
    "tools",
  ]);
  const loop = `for (const path of ["/settings", "/"]) test(path, ({ page }) => page.goto(path));`;
  assert.deepEqual([...navigatedSurfaces(loop, SURFACES)], ["settings"]);
});

test("surface tags are read one per comment line", () => {
  const source =
    "// @surface tracing\n * @surface tools\nconst s = '@surface nope';";
  assert.deepEqual(surfaceTags(source), ["tracing", "tools"]);
});

test("harness pages map to the module they load", () => {
  const router = `
    {
      path: "__e2e/oauth-debugger",
      lazy: async () => {
        const { Harness } = await import("./components/e2e/Harness");
        return { Component: Harness };
      },
    },`;
  assert.deepEqual(
    [...harnessModules(router)],
    [["__e2e/oauth-debugger", "./components/e2e/Harness"]],
  );
});

test("roots follow router entries through App route functions to imported files", () => {
  const routerSource = `
import App, { ToolsRoute, HomeRoute } from "./App";
import { Shell } from "./components/ui/shell";
const ROUTE_ELEMENTS: Record<string, unknown> = {
  "/": { element: <HomeRoute /> },
  tools: { element: <Shell><ToolsRoute /></Shell> },
  // A comment naming <NotRendered /> is not an element.
  "embed/x": { element: <ToolsRoute /> },
};`;
  const appSource = `
import { ToolsTab } from "./components/ToolsTab";
import { HomeTab } from "./components/HomeTab";
import { Gate } from "./components/billing/Gate";

export function ToolsRoute() {
  return (
    <Gate>
      <ToolsTab />
    </Gate>
  );
}

function HomeContent() {
  return <HomeTab />;
}

export function HomeRoute() {
  return <HomeContent />;
}
`;
  const roots = surfaceRoots({
    surfaces: SURFACES,
    routerSource,
    appSource,
    resolve: (_from, specifier) =>
      `client/src/${specifier.replace("./", "")}.tsx`,
  });
  assert.deepEqual(
    [...roots.get("home")],
    ["client/src/components/HomeTab.tsx"],
  );
  assert.deepEqual([...roots.get("tools")].sort(), [
    "client/src/components/ToolsTab.tsx",
    "client/src/components/billing/Gate.tsx",
  ]);
});

test("a module belongs to a surface only when no other surface reaches it", () => {
  const graph = new Map([
    ["A.tsx", new Set(["a-only.ts", "shared.ts"])],
    ["B.tsx", new Set(["shared.ts"])],
    ["Both.tsx", new Set(["both-only.ts"])],
    ["Chrome.tsx", new Set()],
  ]);
  const roots = new Map([
    ["a", new Set(["A.tsx", "Both.tsx", "Chrome.tsx"])],
    ["b", new Set(["B.tsx", "Both.tsx", "Chrome.tsx"])],
    ["c", new Set(["Chrome.tsx"])],
  ]);
  const owners = moduleOwners(graph, roots);
  assert.deepEqual(owners.get("a-only.ts"), ["a"]);
  assert.deepEqual(owners.get("A.tsx"), ["a"]);
  assert.equal(owners.get("shared.ts"), undefined);
  // Two surfaces render it: a test of it covers both.
  assert.deepEqual(owners.get("Both.tsx"), ["a", "b"]);
  assert.equal(owners.get("both-only.ts"), undefined);
  // Three render it: route chrome, covers none.
  assert.equal(owners.get("Chrome.tsx"), undefined);
});

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
