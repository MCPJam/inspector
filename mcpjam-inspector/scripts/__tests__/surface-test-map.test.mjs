import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  destinationSegments,
  exercisedImportSpecifiers,
  harnessModules,
  importSpecifiers,
  matchSurface,
  moduleOwners,
  navigatedSurfaces,
  parseSurfaces,
  runsTests,
  surfaceRoots,
  surfaceTags,
} from "../lib/surface-test-map.mjs";

const INSPECTOR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
    title: "A screen",
    userActivities: ["Open [the] list", "Close it"],
    agentTools: { kind: "none", reason: "has [brackets] and {braces}" },
    showInAtlas: true,
  },
  { id: "b", canonicalPath: "/b", routePatterns: ["b"], showInAtlas: false },
] as const satisfies readonly AppSurfaceManifest[];`);
  const [a, b] = surfaces;
  assert.deepEqual(
    [a.id, a.canonicalPath, a.routePatterns, a.title, a.showInAtlas],
    ["a", "/a", ["a", "a/:x"], "A screen", true],
  );
  assert.deepEqual(a.userActivities, ["Open [the] list", "Close it"]);
  assert.deepEqual(
    [b.id, b.canonicalPath, b.routePatterns, b.title, b.showInAtlas],
    ["b", "/b", ["b"], "", false],
  );
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

test("a goto built from data does not count literals passed to a call", () => {
  const spec = `
    for (const route of ["home"]) {
      test(route, async ({ page }) => {
        await page.goto(\`/p/\${PROJECT_ID}/\${route}\`);
        await expect(page).toHaveURL("/tools");
        await page.getByText( "swarms" ).click();
      });
    }`;
  assert.deepEqual([...navigatedSurfaces(spec, SURFACES)], ["home"]);
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
import App, { ToolsRoute as ToolsTab, HomeRoute } from "./App";
import { Shell } from "./components/ui/shell";
const ROUTE_ELEMENTS: Record<string, unknown> = {
  "/": { element: <HomeRoute /> },
  tools: { element: <Shell><ToolsTab /></Shell> },
  // A comment naming <NotRendered /> is not an element.
  "embed/x": { element: <ToolsTab /> },
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

test("imports in comments and type-only imports are not edges", () => {
  const source = `
import { ToolsTab } from "./ToolsTab";
import { type HomeProps, type HomeState } from "./HomeTab";
import { Gate, type GateProps } from "./Gate";
vi.mock("./Mocked"); // import { Mocked } from "./Mocked";
const url = "https://example.com"; import "./after-url";
const fixture = \`import { Fake } from "./Fake"; \${await import("./Lazy")}\`;
`;
  assert.deepEqual(importSpecifiers(source), [
    "./ToolsTab",
    "./Gate",
    "./after-url",
    "./Lazy",
  ]);
});

test("a typeof import() type query is not an edge; a dynamic import is", () => {
  const source = `
type Module = typeof import("./TracingTab");
const load = () => import("./Lazy");
`;
  assert.deepEqual(importSpecifiers(source), ["./Lazy"]);
});

test("an import() type reference is not an edge; a dynamic import chain is", () => {
  const source = `
type Props = import("./TracingTab").Props;
let state: import( "./Store" ) . State;
const mod = import("./Lazy").then((m) => m.default);
`;
  assert.deepEqual(importSpecifiers(source), ["./Lazy"]);
});

test("an import the test never mentions again exercises nothing", () => {
  const source = `
import { render } from "@testing-library/react";
import { ToolsTab } from "./ToolsTab";
import TracingTab from "./TracingTab";
import * as Home from "./HomeTab";
import { Store as UsedStore } from "./Store";
import "./setup";
// render(<TracingTab />)
const label = "TracingTab";
const s = UsedStore;
render(<ToolsTab />);
`;
  assert.deepEqual(exercisedImportSpecifiers(source), [
    "@testing-library/react",
    "./ToolsTab",
    "./Store",
    "./setup",
  ]);
});

test("a file whose every test is skipped runs nothing", () => {
  const skipped = [
    `it.skip("a", () => {}); test.todo("b"); xit("c", () => {});`,
    `describe.skip("suite", () => { it("a", () => {}); test("b", () => {}); });`,
    `test.describe.skip("suite", () => { test("a", async () => {}); });`,
    `xdescribe("suite", () => { it.each([1])("a %s", () => {}); });`,
    `const ok = /x/.test("it(x)"); it.skip("a", () => {}); // it("b", () => {})`,
    `test.concurrent.skip("a", () => {});`,
    `test.skip.concurrent("a", () => {});`,
    `it.skip.each([1])("a %s", () => {});`,
    `test.skip(/* disabled temporarily */ "a", () => {});`,
  ];
  for (const source of skipped) assert.equal(runsTests(source), false, source);
  const runs = [
    `describe.skip("old", () => { it("a", () => {}); }); it("b", () => {});`,
    `test.describe("s", () => { test.skip(!!process.env.CI, "local"); test("a", async () => {}); });`,
    "it.each([1, 2])('%s', (n) => {});",
    "it.each<[number]>([[1]])('%s', (n) => {});",
    "test.only(`x`, () => {});",
    `import { describeColdLoad } from "./support"; describeColdLoad({ label: "x" });`,
    `test.concurrent.skip("a", () => {}); test.concurrent("b", () => {});`,
    `import { describeColdLoad } from "./support"; test.skip(false, "not disabled"); describeColdLoad({ label: "x" });`,
    `import { describeColdLoad } from "./support"; test.skip(({ browserName }) => browserName === "webkit", "x"); describeColdLoad({});`,
  ];
  for (const source of runs) assert.equal(runsTests(source), true, source);
});

test("import text quoted in a string is not an edge", () => {
  const source = `
const fixture = 'import("./TracingTab")';
const other = "import { Fake } from './Fake'";
const run = \`\${await import("./Lazy")}\`;
`;
  assert.deepEqual(importSpecifiers(source), ["./Lazy"]);
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
