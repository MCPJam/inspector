/**
 * Reads the inspector tree and joins each surface to the tests that exercise
 * it, by the rules in `check-surface-test-coverage.mjs`. The one scanner the
 * coverage check and any other surface tool share, so a screen cannot have
 * two test inventories.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  exercisedImportSpecifiers,
  harnessModules,
  importSpecifiers,
  moduleOwners,
  navigatedSurfaces,
  navigationTargets,
  runsTests,
  surfaceRoots,
  surfaceTags,
} from "./surface-test-map.mjs";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];

const toRel = (root, file) => relative(root, file).split(sep).join("/");

/**
 * Builds a resolver for import specifiers, from the inspector root's
 * point of view, matching the client's `@/` and `@/shared/` aliases.
 */
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

/**
 * Every file under a scan root. A missing root yields nothing, and the
 * empty-scan checks report it; any other filesystem error, or one below the
 * root, fails the scan so a subtree cannot drop out unnoticed.
 */
function* walk(dir, isRoot = true) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if (isRoot && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full, false);
    else yield full;
  }
}

const isSource = (rel) =>
  SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext)) && !rel.endsWith(".d.ts");
const isComponentTest = (rel) =>
  rel.split("/").includes("__tests__") && /\.test\.tsx?$/.test(rel);
const isE2ESpec = (rel) => /\.(?:spec|browser)\.ts$/.test(rel);

/**
 * Each surface's root files, E2E specs and component tests; the import graph
 * of `client/src` and `shared`; how many files were scanned; and `@surface`
 * tags that name no surface. A test file with no test that runs links nothing.
 */
export function scanSurfaceTests(root, surfaces) {
  const ids = new Set(surfaces.map((s) => s.id));
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

  const routerSource = read("client/src/router.tsx");
  const roots = surfaceRoots({
    surfaces,
    routerSource,
    appSource: read("client/src/App.tsx"),
    resolve: res,
  });
  const owners = moduleOwners(graph, roots);
  const harnesses = harnessModules(routerSource);

  const unknownTags = [];
  const linkSpecifiers = (rel, specifiers, into) => {
    for (const spec of specifiers) {
      for (const owner of owners.get(res(rel, spec) ?? "") ?? [])
        into.add(owner);
    }
  };
  const linkHarnesses = (source, into) => {
    for (const segments of navigationTargets(source)) {
      const specifier = harnesses.get(segments.join("/"));
      const harness = specifier && res("client/src/router.tsx", specifier);
      if (harness) linkSpecifiers(harness, importSpecifiers(read(harness)), into);
    }
  };
  const linkByImports = (rel, source, into) => {
    linkSpecifiers(rel, exercisedImportSpecifiers(source), into);
    for (const tag of surfaceTags(source)) {
      if (ids.has(tag)) into.add(tag);
      else unknownTags.push(`${rel}: @surface ${tag}`);
    }
  };

  const e2e = new Map(surfaces.map((s) => [s.id, []]));
  let e2eFiles = 0;
  for (const file of walk(join(root, "e2e"))) {
    const rel = toRel(root, file);
    if (!isE2ESpec(rel)) continue;
    e2eFiles += 1;
    const source = read(rel);
    if (!runsTests(source)) continue;
    const linked = navigatedSurfaces(source, surfaces);
    linkHarnesses(source, linked);
    linkByImports(rel, source, linked);
    for (const id of linked) e2e.get(id).push(rel);
  }

  const component = new Map(surfaces.map((s) => [s.id, []]));
  let componentFiles = 0;
  for (const dir of ["client", "shared"]) {
    for (const file of walk(join(root, dir))) {
      const rel = toRel(root, file);
      if (!isComponentTest(rel)) continue;
      componentFiles += 1;
      const source = read(rel);
      if (!runsTests(source)) continue;
      const linked = new Set();
      linkByImports(rel, source, linked);
      for (const id of linked) component.get(id).push(rel);
    }
  }

  return {
    graph,
    roots,
    e2e,
    component,
    scanned: { e2eFiles, componentFiles, modules: graph.size },
    unknownTags,
  };
}
