/**
 * The feature map behind `scripts/feature-map.mjs`: every app surface with
 * the words a user sees for it, where it sits in the navigation, the files
 * that render it and the tests that exercise it, plus a deterministic ranking
 * of surfaces against a loose phrase. Everything except the alias file is
 * read from source, so the map moves when the app does.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  destinationSegments,
  harnessModules,
  importSpecifiers,
  matchSurface,
  moduleOwners,
  navigatedSurfaces,
  parseSurfaces,
  scanSource,
  surfaceRoots,
  surfaceTags,
} from "./surface-test-map.mjs";

export const SOURCES = {
  surfaces: "shared/app-surfaces.ts",
  router: "client/src/router.tsx",
  app: "client/src/App.tsx",
  sidebar: "client/src/components/mcp-sidebar.tsx",
  connectTabs: "client/src/components/hosts/ConnectViewHeader.tsx",
  aliases: "scripts/feature-map-aliases.json",
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const COMPONENTS_DIR = "client/src/components/";
const DESIGN_SYSTEM_DIR = "client/src/components/ui/";

const unquote = (raw) => {
  const value = raw.trim().replace(/,$/, "");
  const quoted = /^"([^"]*)"$/.exec(value);
  if (quoted) return quoted[1];
  const list = /^\[(.*)\]$/.exec(value);
  if (list) return [...list[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  // An identifier such as `EVENTS_FEATURE_FLAG`; kept as written.
  return value;
};

/**
 * Sidebar items in render order: `navigationSections` (section label, then
 * items) and the signed-out footer icons. Line-based, which relies on Prettier
 * putting one property per line in these arrays.
 */
export function parseSidebar(source) {
  const blocks = [
    ["export const navigationSections", null],
    ["const signedOutUtilityItems", "Footer"],
  ];
  const items = [];
  for (const [marker, fixedSection] of blocks) {
    const start = source.indexOf(marker);
    const end = source.indexOf("\n];", start);
    if (start === -1 || end === -1) {
      throw new Error(`${marker} not found in ${SOURCES.sidebar}`);
    }
    let section = fixedSection;
    let item = null;
    for (const line of source.slice(start, end).split("\n")) {
      const prop =
        /^\s+(label|title|url|featureFlag|hiddenByFlag|badge|matchTabs):\s*(.+)$/.exec(
          line,
        );
      if (!prop) continue;
      const [, key, raw] = prop;
      if (key === "label") section = unquote(raw);
      else if (key === "title") {
        item = { section, title: unquote(raw), matchTabs: [] };
        items.push(item);
      } else if (item) item[key] = unquote(raw);
    }
  }
  return items;
}

/** The Connect view's tab switcher: its aria label and `{ value, label }` tabs. */
export function parseConnectTabs(source) {
  const view = /ariaLabel="([^"]+)"/.exec(source)?.[1] ?? "Connect view";
  const tabs = [
    ...source.matchAll(/\{\s*value:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g),
  ].map((m) => ({ value: m[1], label: m[2] }));
  return { view, tabs };
}

const singular = (word) => word.replace(/s$/, "");

/**
 * Where each surface sits in the navigation, by id. A sidebar item lands on
 * the surface its URL routes to; an item's `matchTabs` are the screens it
 * stays highlighted for; a Connect tab lands on the surface whose id or nav
 * segment it names (`host` is the `hosts` surface).
 */
export function navigationPlaces(surfaces, sidebarItems, connectTabs) {
  const places = new Map(surfaces.map((s) => [s.id, []]));
  const byNavSegment = (segment) =>
    surfaces.find((s) =>
      [s.id, ...s.navSegments].some(
        (name) => name === segment || singular(name) === segment,
      ),
    );
  for (const item of sidebarItems) {
    const segments = destinationSegments(item.url);
    const id = segments && matchSurface(surfaces, segments);
    const where = item.section === "Footer" ? "footer" : "sidebar";
    if (id) {
      places.get(id).push({
        where,
        path: [item.section, item.title],
        label: item.title,
        ...(item.featureFlag && { featureFlag: item.featureFlag }),
        ...(item.hiddenByFlag && { hiddenByFlag: item.hiddenByFlag }),
      });
    }
    for (const tab of item.matchTabs) {
      const surface = byNavSegment(tab);
      if (surface && surface.id !== id) {
        places.get(surface.id).push({
          where: "highlights",
          path: [item.section, item.title],
        });
      }
    }
  }
  for (const tab of connectTabs.tabs) {
    const surface = byNavSegment(tab.value);
    if (surface) {
      places.get(surface.id).push({
        where: "tab",
        path: [connectTabs.view, tab.label],
        label: tab.label,
      });
    }
  }
  return places;
}

/** What the UI calls a surface: its sidebar item, else its tab, else its manifest title. */
export function primaryLabel(surface, places) {
  const visible = places.filter((p) => p.label && !p.hiddenByFlag);
  return (
    visible.find((p) => p.where === "sidebar")?.label ??
    visible.find((p) => p.where === "tab")?.label ??
    visible[0]?.label ??
    surface.title
  );
}

export function describePlace(place) {
  const path = place.path.join(" > ");
  if (place.where === "tab") return `${path} tab`;
  if (place.where === "highlights") return `under Sidebar > ${path}`;
  const flags = [
    place.featureFlag && `flag ${place.featureFlag}`,
    place.hiddenByFlag && `hidden when ${place.hiddenByFlag} is on`,
  ].filter(Boolean);
  const where =
    place.where === "footer" ? "Sidebar footer (signed out)" : "Sidebar";
  return `${where} > ${place.where === "footer" ? place.label : path}${
    flags.length ? ` (${flags.join("; ")})` : ""
  }`;
}

function makeResolver(root) {
  const cache = new Map();
  const tryFile = (base) => {
    if (cache.has(base)) return cache.get(base);
    let hit = null;
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates = [
      base,
      ...SOURCE_EXTENSIONS.map((ext) => stem + ext),
      ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        hit = toRel(root, candidate);
        break;
      }
    }
    cache.set(base, hit);
    return hit;
  };
  return (fromRel, specifier) => {
    if (specifier.startsWith("@/shared/")) {
      return tryFile(join(root, "shared", specifier.slice("@/shared/".length)));
    }
    if (specifier.startsWith("@/")) {
      return tryFile(join(root, "client/src", specifier.slice(2)));
    }
    if (specifier.startsWith(".")) {
      return tryFile(join(root, dirname(fromRel), specifier));
    }
    return null;
  };
}

const toRel = (root, file) => relative(root, file).split(sep).join("/");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const isSource = (rel) =>
  SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext)) && !rel.endsWith(".d.ts");
const isComponentTest = (rel) =>
  rel.split("/").includes("__tests__") && /\.test\.tsx?$/.test(rel);
const isE2ESpec = (rel) => /\.(?:spec|browser)\.ts$/.test(rel);

/**
 * Each surface's root files, its E2E specs and its component tests, joined by
 * the rules documented in `surface-test-map.mjs`; and the import graph.
 */
export function readSurfaceTests(root, surfaces) {
  const res = makeResolver(root);
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const graph = new Map();
  for (const dir of ["client/src", "shared"]) {
    for (const file of walk(join(root, dir))) {
      const rel = toRel(root, file);
      if (!isSource(rel) || isComponentTest(rel)) continue;
      const deps = new Set();
      for (const spec of importSpecifiers(read(rel))) {
        const target = res(rel, spec);
        if (target) deps.add(target);
      }
      graph.set(rel, deps);
    }
  }
  const routerSource = read(SOURCES.router);
  const roots = surfaceRoots({
    surfaces,
    routerSource,
    appSource: read(SOURCES.app),
    resolve: res,
  });
  const owners = moduleOwners(graph, roots);
  const harnesses = harnessModules(routerSource);
  const ids = new Set(surfaces.map((s) => s.id));

  const linkImports = (rel, source, into) => {
    for (const spec of importSpecifiers(source)) {
      for (const owner of owners.get(res(rel, spec) ?? "") ?? [])
        into.add(owner);
    }
    for (const tag of surfaceTags(source)) if (ids.has(tag)) into.add(tag);
  };
  const e2e = new Map(surfaces.map((s) => [s.id, []]));
  for (const file of walk(join(root, "e2e"))) {
    const rel = toRel(root, file);
    if (!isE2ESpec(rel)) continue;
    const source = read(rel);
    const linked = navigatedSurfaces(source, surfaces);
    for (const literal of scanSource(source).literals) {
      const segments = destinationSegments(literal.value);
      const specifier = segments && harnesses.get(segments.join("/"));
      const harness = specifier && res(SOURCES.router, specifier);
      if (harness) linkImports(harness, read(harness), linked);
    }
    linkImports(rel, source, linked);
    for (const id of linked) e2e.get(id).push(rel);
  }
  const component = new Map(surfaces.map((s) => [s.id, []]));
  for (const dir of ["client", "shared"]) {
    for (const file of walk(join(root, dir))) {
      const rel = toRel(root, file);
      if (!isComponentTest(rel)) continue;
      const linked = new Set();
      linkImports(rel, read(rel), linked);
      for (const id of linked) component.get(id).push(rel);
    }
  }
  return { graph, roots, e2e, component };
}

/**
 * Components a root file renders one import down: feature components only,
 * not design-system primitives, hooks or helpers.
 */
export function childComponents(graph, rootFiles) {
  const out = new Set();
  for (const file of rootFiles) {
    for (const dep of graph.get(file) ?? []) {
      if (
        dep.startsWith(COMPONENTS_DIR) &&
        !dep.startsWith(DESIGN_SYSTEM_DIR) &&
        dep.endsWith(".tsx") &&
        !rootFiles.includes(dep)
      ) {
        out.add(dep);
      }
    }
  }
  return [...out].sort();
}

/** The whole map, read from the inspector tree at `root`. */
export function buildFeatureMap(root, { withTests = true } = {}) {
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const surfaces = parseSurfaces(read(SOURCES.surfaces));
  const places = navigationPlaces(
    surfaces,
    parseSidebar(read(SOURCES.sidebar)),
    parseConnectTabs(read(SOURCES.connectTabs)),
  );
  const aliases = JSON.parse(read(SOURCES.aliases));
  const tests = withTests ? readSurfaceTests(root, surfaces) : null;
  return surfaces.map((s) => {
    const roots = tests ? [...tests.roots.get(s.id)].sort() : [];
    return {
      id: s.id,
      label: primaryLabel(s, places.get(s.id)),
      title: s.title,
      scope: s.scope,
      route:
        s.scope === "project"
          ? `/p/:projectId${s.canonicalPath}`
          : s.canonicalPath,
      routePatterns: s.routePatterns,
      navSegments: s.navSegments,
      places: places.get(s.id),
      purpose: s.purpose,
      userActivities: s.userActivities,
      inAtlas: s.showInAtlas,
      aliases: aliases[s.id] ?? [],
      roots,
      children: tests ? childComponents(tests.graph, roots) : [],
      e2e: tests ? tests.e2e.get(s.id).sort() : [],
      component: tests ? tests.component.get(s.id).sort() : [],
    };
  });
}

// Words that say nothing about which screen is meant.
const STOPWORDS = new Set(
  (
    "a an and are at be can do does find for from go how i in is it its me my " +
    "of on one or page screen see show that the thing thingy stuff this to up " +
    "use view where which with you your left right top bottom bit part area " +
    "place spot section panel menu window want get"
  ).split(" "),
);

/** Crude suffix stripping, enough that `traces` and `tracing` meet at `trac`. */
function stem(word) {
  let w = word;
  if (w.length > 3 && !w.endsWith("ss")) w = w.replace(/s$/, "");
  if (w.length > 4) w = w.replace(/(?:ing|ed|e)$/, "");
  return w;
}

/** Lowercase word stems without stopwords: `TracingTabs` → `trac`, `tab`. */
export function words(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * The searchable text of one surface, by field. Weights: a word the UI shows
 * or the code names the screen by counts most; URLs, navigation context and
 * file names less (a root can be a wrapper such as a billing gate); the
 * model-facing prose least, since it mentions other screens.
 */
export function searchFields(entry) {
  const fileNames = entry.roots.map((f) => f.replace(/^.*\/|\.tsx?$/g, ""));
  const routeWords = entry.routePatterns.map((p) =>
    p
      .split("/")
      .filter((s) => !s.startsWith(":"))
      .join(" "),
  );
  return [
    { field: "label", weight: 5, phrases: [entry.label, entry.title] },
    { field: "id", weight: 5, phrases: [entry.id, ...entry.navSegments] },
    {
      field: "tab",
      weight: 5,
      phrases: entry.places
        .filter((p) => p.where === "tab")
        .map((p) => p.label),
    },
    {
      field: "sidebar",
      weight: 4,
      phrases: entry.places.filter((p) => p.label).map((p) => p.label),
    },
    { field: "alias", weight: 4, phrases: entry.aliases },
    { field: "route", weight: 2, phrases: routeWords },
    { field: "component", weight: 1.5, phrases: fileNames },
    {
      field: "place",
      weight: 1.5,
      phrases: entry.places.map((p) => `${p.where} ${p.path.join(" ")}`),
    },
    { field: "purpose", weight: 1.5, phrases: [entry.purpose] },
    { field: "activity", weight: 1, phrases: entry.userActivities },
  ].map((f) => ({ ...f, words: new Set(f.phrases.flatMap(words)) }));
}

// A match on a field at least this heavy (a name or a URL, not prose or a
// file name) is what makes a result confident.
const STRONG_WEIGHT = 2;
// A prose field a word also matches in adds this share of its value.
const ECHO_SHARE = 0.25;
const PROSE_FIELDS = new Set(["purpose", "activity"]);

/** How well query word `q` matches field word `w`: 1 exact, 0.5 one is a prefix of the other. */
function wordMatch(q, w) {
  if (q === w) return 1;
  const [short, long] = q.length < w.length ? [q, w] : [w, q];
  return short.length >= 3 && long.startsWith(short) ? 0.5 : 0;
}

/**
 * Ranks surfaces against a phrase. Each query word scores its best field
 * match, plus a quarter of every other field it also matches, scaled by how
 * rare the word is across surfaces (`run` names half the app, `oauth` one
 * screen). A label or alias whose every word is in the query adds its weight
 * again, so a two-word name beats two scattered hits. A surface no navigation
 * or atlas reaches (a redirect kept for old links) counts half.
 */
export function rankSurfaces(entries, phrase) {
  const query = [...new Set(words(phrase))];
  const indexed = entries.map((entry) => ({
    entry,
    fields: searchFields(entry),
  }));
  const df = (q) =>
    indexed.filter(({ fields }) =>
      fields.some((f) => [...f.words].some((w) => wordMatch(q, w))),
    ).length;
  const idf = new Map(
    query.map((q) => [q, Math.log(1 + entries.length / Math.max(1, df(q)))]),
  );
  const results = indexed.map(({ entry, fields }) => {
    let score = 0;
    let strong = false;
    const reasons = [];
    for (const q of query) {
      const hits = [];
      for (const f of fields) {
        let hit = null;
        for (const w of f.words) {
          const value = f.weight * wordMatch(q, w);
          if (value > (hit?.value ?? 0)) hit = { value, field: f, word: w };
        }
        if (hit) hits.push(hit);
      }
      if (!hits.length) continue;
      hits.sort((a, b) => b.value - a.value);
      const [best, ...others] = hits;
      // Names repeat each other (label, id, URL, file); only the prose is a
      // second, independent mention.
      const echo =
        others
          .filter((h) => PROSE_FIELDS.has(h.field.field))
          .reduce((sum, h) => sum + h.value, 0) * ECHO_SHARE;
      score += (best.value + echo) * idf.get(q);
      if (best.field.weight >= STRONG_WEIGHT) strong = true;
      reasons.push(
        `"${q}" ~ ${best.field.field}${best.word === q ? "" : ` "${best.word}"`}`,
      );
    }
    // Several query words inside one name, URL or sentence of this surface
    // say more than the same words scattered across the app. Best phrase per
    // field; a name with every word present counts its weight again.
    for (const f of fields) {
      let top = null;
      for (const name of f.phrases) {
        const nameWords = words(name);
        const found = query.filter((q) =>
          nameWords.some((w) => wordMatch(q, w)),
        );
        if (found.length < 2) continue;
        const whole =
          f.weight >= 4 && nameWords.every((w) => query.includes(w));
        const meanIdf =
          found.reduce((sum, q) => sum + idf.get(q), 0) / found.length;
        const value =
          f.weight * (found.length - 1) * meanIdf + (whole ? f.weight : 0);
        if (value > (top?.value ?? 0)) top = { value, name };
      }
      if (!top) continue;
      score += top.value;
      strong = true;
      reasons.push(`${f.field} "${top.name}" holds several query words`);
    }
    const reachable = entry.places.length > 0 || entry.inAtlas;
    if (!reachable && score > 0) {
      score /= 2;
      reasons.push("no navigation reaches it: halved");
    }
    return { id: entry.id, label: entry.label, score, strong, reasons };
  });
  const ranked = results
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const unmatched = query.filter((q) => df(q) === 0);
  return { query, unmatched, ranked, confident: ranked[0]?.strong ?? false };
}
