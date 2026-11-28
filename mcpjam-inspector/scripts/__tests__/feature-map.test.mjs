import { test } from "node:test";
import assert from "node:assert/strict";
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
import { buildFeatureMap as buildCoverageMap } from "../check-surface-test-coverage.mjs";
import {
  SOURCES,
  buildFeatureMap,
  childComponents,
  describePlace,
  navigationPlaces,
  parseConnectTabs,
  parseSidebar,
  primaryLabel,
  rankSurfaces,
  words,
} from "../lib/feature-map.mjs";
import { parseSurfaces } from "../lib/surface-test-map.mjs";

const INSPECTOR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(INSPECTOR, rel), "utf8");

const surface = (id, extra = {}) => ({
  id,
  canonicalPath: `/${id}`,
  routePatterns: [id],
  navSegments: [id],
  title: id,
  ...extra,
});

const SIDEBAR = `
export const navigationSections: NavSection[] = [
  {
    id: "explore",
    label: "Explore",
    items: [
      {
        title: "Connect",
        url: "/servers",
        icon: Cable,
        featureFlag: "hosts-enabled",
        matchTabs: ["clients", "skills"],
      },
      {
        // Legacy fallback with a label: "Nope" in a comment.
        title: "Servers",
        url: "/servers",
        hiddenByFlag: "hosts-enabled",
      },
    ],
  },
  {
    id: "inspect",
    label: "Inspect",
    items: [
      {
        title: "Events",
        url: "/events",
        featureFlag: EVENTS_FEATURE_FLAG,
      },
    ],
  },
];

const signedOutUtilityItems: NavItem[] = [
  {
    title: "Support",
    url: "/settings/support",
  },
];`;

const CONNECT_HEADER = `
<ViewModeSelector
  ariaLabel="Connect view"
  options={[
    { value: "servers", label: "Servers" },
    {
      value: "host",
      label: "Client",
      disabled: !previewedHostId,
    },
    ...(showSkillsTab ? ([{ value: "skills", label: "Skills" }] as const) : []),
  ]}
/>`;

const SURFACES = [
  surface("servers", { navSegments: ["servers", "client-config"] }),
  surface("hosts", { navSegments: ["clients"] }),
  surface("skills"),
  surface("events"),
  surface("support", {
    canonicalPath: "/settings/support",
    routePatterns: ["settings/support"],
  }),
  surface("tracing"),
];

test("sidebar items carry their section, flags and highlighted tabs; comments are skipped", () => {
  const items = parseSidebar(SIDEBAR);
  assert.deepEqual(
    items.map((i) => [i.section, i.title, i.url]),
    [
      ["Explore", "Connect", "/servers"],
      ["Explore", "Servers", "/servers"],
      ["Inspect", "Events", "/events"],
      ["Footer", "Support", "/settings/support"],
    ],
  );
  assert.equal(items[0].featureFlag, "hosts-enabled");
  assert.deepEqual(items[0].matchTabs, ["clients", "skills"]);
  assert.equal(items[1].hiddenByFlag, "hosts-enabled");
  // Not a string: kept as the identifier the source names.
  assert.equal(items[2].featureFlag, "EVENTS_FEATURE_FLAG");
});

test("navigation places: sidebar items by URL, highlights by matchTabs, tabs by value", () => {
  const places = navigationPlaces(
    SURFACES,
    parseSidebar(SIDEBAR),
    parseConnectTabs(CONNECT_HEADER),
  );
  const described = (id) => places.get(id).map(describePlace);
  assert.deepEqual(described("servers"), [
    "Sidebar > Explore > Connect (flag hosts-enabled)",
    "Sidebar > Explore > Servers (hidden when hosts-enabled is on)",
    "Connect view > Servers tab",
  ]);
  // The tab value is singular, the surface id plural.
  assert.deepEqual(described("hosts"), [
    "under Sidebar > Explore > Connect",
    "Connect view > Client tab",
  ]);
  assert.deepEqual(described("support"), [
    "Sidebar footer (signed out) > Support",
  ]);
  assert.deepEqual(described("tracing"), []);
  assert.equal(primaryLabel(SURFACES[0], places.get("servers")), "Connect");
  assert.equal(primaryLabel(SURFACES[1], places.get("hosts")), "Client");
  assert.equal(primaryLabel(SURFACES[5], places.get("tracing")), "tracing");
});

test("every item in the real sidebar and Connect tabs lands on a real surface", () => {
  const surfaces = parseSurfaces(read(SOURCES.surfaces));
  const items = parseSidebar(read(SOURCES.sidebar));
  const tabs = parseConnectTabs(read(SOURCES.connectTabs));
  assert.ok(items.length >= 15, `parsed only ${items.length} sidebar items`);
  assert.ok(tabs.tabs.length >= 3, `parsed only ${tabs.tabs.length} tabs`);
  const places = navigationPlaces(surfaces, items, tabs);
  const placedLabels = new Set([...places.values()].flat().map((p) => p.label));
  for (const item of items) {
    assert.ok(placedLabels.has(item.title), `sidebar "${item.title}" unplaced`);
  }
  for (const tab of tabs.tabs) {
    assert.ok(placedLabels.has(tab.label), `tab "${tab.label}" unplaced`);
  }
});

test("every alias key is a real surface id, with at least one alias", () => {
  const ids = new Set(parseSurfaces(read(SOURCES.surfaces)).map((s) => s.id));
  const aliases = JSON.parse(read(SOURCES.aliases));
  for (const [id, list] of Object.entries(aliases)) {
    assert.ok(ids.has(id), `alias key "${id}" is not a surface id`);
    assert.ok(
      Array.isArray(list) && list.length > 0 && list.every((a) => a.trim()),
      `aliases for "${id}" must be non-empty strings`,
    );
  }
});

test("words split camelCase, drop stopwords and meet at a common stem", () => {
  assert.deepEqual(words("the TracingTabs thing"), ["trac", "tab"]);
  assert.deepEqual(words("traces"), words("tracing"));
  assert.deepEqual(words("OAuth-Debugger"), ["oauth", "debugger"]);
});

const entry = (id, extra = {}) => ({
  id,
  label: id,
  title: id,
  navSegments: [id],
  routePatterns: [id],
  places: [{ where: "sidebar", path: ["S", id], label: id }],
  purpose: "",
  userActivities: [],
  inAtlas: true,
  aliases: [],
  roots: [],
  ...extra,
});

const ENTRIES = [
  entry("oauth-flow", {
    label: "OAuth Debugger",
    purpose: "Step through an OAuth authorization flow against a server.",
  }),
  entry("servers", {
    label: "Connect",
    purpose: "Connect and manage MCP servers; authorize a server with OAuth.",
    userActivities: ["Edit a server's environment variables"],
  }),
  entry("environments", { label: "Environments" }),
  entry("home", {
    label: "Home",
    purpose: "The landing screen with an overview.",
    roots: ["client/src/components/HomeTab.tsx"],
  }),
  entry("evals", {
    label: "Legacy eval links",
    places: [],
    inAtlas: false,
    purpose: "Old links that redirect to evaluate.",
  }),
  entry("evaluate", {
    label: "Evaluate",
    aliases: ["evals"],
    purpose: "Run eval suites.",
  }),
];

test("a label beats the same word in another surface's prose", () => {
  const { ranked, confident } = rankSurfaces(ENTRIES, "oauth debugger");
  assert.equal(ranked[0].id, "oauth-flow");
  assert.equal(ranked[1].id, "servers");
  assert.ok(confident);
  assert.ok(
    ranked[0].reasons.some((r) => r.includes("holds several query words")),
  );
});

test("a redirect no navigation reaches loses to the screen that took its name", () => {
  const { ranked } = rankSurfaces(ENTRIES, "where I run evals");
  assert.equal(ranked[0].id, "evaluate");
  const legacy = ranked.find((r) => r.id === "evals");
  assert.ok(legacy.reasons.includes("no navigation reaches it: halved"));
});

test("two words in one sentence of a surface count together", () => {
  const { ranked } = rankSurfaces(ENTRIES, "edit environment variables");
  assert.equal(ranked[0].id, "servers");
});

test("prose alone is never confident; unknown words match nothing", () => {
  const landing = rankSurfaces(ENTRIES, "landing");
  assert.equal(landing.ranked[0].id, "home");
  assert.equal(landing.confident, false);
  const none = rankSurfaces(ENTRIES, "the kubernetes thing");
  assert.deepEqual(none.query, ["kubernet"]);
  assert.deepEqual(none.unmatched, ["kubernet"]);
  assert.deepEqual(none.ranked, []);
  assert.equal(none.confident, false);
});

test("an exact URL word is confident; a prefix of one is not", () => {
  const auth = entry("sign-in", {
    label: "Sign in",
    title: "Sign in",
    routePatterns: ["auth"],
    places: [],
    roots: ["client/src/components/AuthPanel.tsx"],
  });
  assert.ok(rankSurfaces([auth], "auth").confident);
  const prefixOnly = rankSurfaces([auth], "authentication");
  assert.equal(prefixOnly.ranked[0].id, "sign-in");
  assert.equal(prefixOnly.confident, false);
  const fileOnly = rankSurfaces(
    [{ ...auth, routePatterns: ["login"] }],
    "auth",
  );
  assert.equal(fileOnly.confident, false);
});

test("a close runner-up or a tie abstains and names the candidates", () => {
  const twins = [
    entry("project-settings", { label: "Settings" }),
    entry("settings", { label: "Settings" }),
    entry("tools", { label: "Tools" }),
  ];
  const tie = rankSurfaces(twins, "settings");
  assert.equal(tie.confident, false);
  assert.deepEqual(tie.ambiguous, ["settings"]);
  const clear = rankSurfaces(twins, "tools");
  assert.equal(clear.confident, true);
  assert.deepEqual(clear.ambiguous, []);
});

test("held-out queries: an irrelevant word abstains even beside a real one", () => {
  for (const phrase of ["oauth kubernetes", "where is the billing page"]) {
    const result = rankSurfaces(ENTRIES, phrase);
    assert.equal(result.confident, false, phrase);
    assert.ok(result.unmatched.length > 0, phrase);
  }
  assert.equal(rankSurfaces(ENTRIES, "oauth").confident, true);
});

test("several query words in a file name are not confident; in prose they are", () => {
  const wizard = entry("sign-in", {
    label: "Sign in",
    title: "Sign in",
    routePatterns: ["login"],
    places: [],
    purpose: "Finish the authentication wizard to reach your workspace.",
    roots: ["client/src/components/AuthenticationWizard.tsx"],
  });
  const fileOnly = rankSurfaces(
    [{ ...wizard, purpose: "" }],
    "authentication wizard",
  );
  assert.ok(
    fileOnly.ranked[0].reasons.some(
      (r) => r.includes("component") && r.includes("several query words"),
    ),
  );
  assert.equal(fileOnly.confident, false);
  assert.equal(rankSurfaces([wizard], "authentication wizard").confident, true);
});

test("ranking is deterministic: equal scores order by id", () => {
  const tied = [entry("b-screen"), entry("a-screen")].map((e) => ({
    ...e,
    label: "Twin",
  }));
  const { ranked } = rankSurfaces(tied, "twin");
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["a-screen", "b-screen"],
  );
});

test("children are feature components one import down, not primitives or helpers", () => {
  const graph = new Map([
    [
      "client/src/components/ToolsTab.tsx",
      new Set([
        "client/src/components/tools/ToolList.tsx",
        "client/src/components/ui/button.tsx",
        "client/src/lib/format.ts",
        "client/src/components/ToolsTab.tsx",
      ]),
    ],
  ]);
  assert.deepEqual(
    childComponents(graph, ["client/src/components/ToolsTab.tsx"]),
    ["client/src/components/tools/ToolList.tsx"],
  );
});

test("the CLI and the coverage check report the same tests for each surface", () => {
  const files = {
    [SOURCES.surfaces]: `export const APP_SURFACES = [
  { id: "oauth", canonicalPath: "/oauth", routePatterns: ["oauth"], navSegments: ["oauth"] },
  { id: "tools", canonicalPath: "/tools", routePatterns: ["tools"], navSegments: ["tools"] },
] as const satisfies readonly AppSurfaceManifest[];`,
    [SOURCES.router]: `import { OAuthTab } from "./components/OAuthTab";
import { ToolsTab } from "./components/ToolsTab";
const ROUTE_ELEMENTS = {
  oauth: { element: <OAuthTab /> },
  tools: { element: <ToolsTab /> },
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
    [SOURCES.app]: "export {};",
    [SOURCES.sidebar]: SIDEBAR,
    [SOURCES.connectTabs]: CONNECT_HEADER,
    [SOURCES.aliases]: "{}",
    "client/src/components/OAuthTab.tsx": "export function OAuthTab() {}",
    "client/src/components/ToolsTab.tsx": "export function ToolsTab() {}",
    "client/src/components/e2e/Harness.tsx": 'import { OAuthTab } from "../OAuthTab";',
    "e2e/harness.spec.ts": 'test("opens", ({ page }) => page.goto("/__e2e/oauth-debugger"));',
    "e2e/tagged.spec.ts": `// @surface tools
test("clicks through", async () => {});`,
    "client/src/components/__tests__/tools.test.tsx": `import { ToolsTab } from "../ToolsTab";
it("renders", () => render(<ToolsTab />));`,
    "client/src/components/__tests__/types.test.ts": `type P = import("../OAuthTab").Props;
it("types", () => {});`,
  };
  const dir = mkdtempSync(join(tmpdir(), "mcpjam-feature-map-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    const cli = buildFeatureMap(dir).map(({ id, e2e, component }) => ({
      id,
      e2e,
      component,
    }));
    const check = buildCoverageMap(dir).surfaces.map(
      ({ id, e2e, component }) => ({ id, e2e, component }),
    );
    assert.deepEqual(cli, check);
    assert.deepEqual(cli, [
      { id: "oauth", e2e: ["e2e/harness.spec.ts"], component: [] },
      {
        id: "tools",
        e2e: ["e2e/tagged.spec.ts"],
        component: ["client/src/components/__tests__/tools.test.tsx"],
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
