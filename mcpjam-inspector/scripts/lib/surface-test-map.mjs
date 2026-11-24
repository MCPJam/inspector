/**
 * Text-level readers behind `check-surface-test-coverage.mjs`: the surface
 * manifests, the route table, spec navigation and import edges. Pure
 * functions over source strings, so the join can be tested without a tree on
 * disk, and so the check runs on Node builtins with no TypeScript install.
 */

/** Stands in for every `${…}` of a template literal. */
export const PLACEHOLDER = ":*";

/**
 * Servers and Hosts render the same two tab components; a component more
 * surfaces render than that is route chrome, not part of a screen.
 */
const MAX_SURFACES_PER_ROOT = 2;

const DESIGN_SYSTEM_DIR = "client/src/components/ui/";

// After one of these, `/` starts a regex literal rather than a division.
const REGEX_PRECEDERS = new Set(["", ..."(,=:[!&|?{};+-*%<>~^".split("")]);

/**
 * String literals of a JS/TS source (JSX text is not supported), plus the
 * source with comments blanked out (offsets kept). A template literal's
 * `${…}` becomes {@link PLACEHOLDER} in its value, and the literals inside the
 * expression are reported on their own. `executable` also blanks template
 * text, keeping its `${…}` expressions: only those can run an import.
 */
export function scanSource(source) {
  const literals = [];
  const code = source.split("");
  const executable = source.split("");
  const blankIn = (chars, from, to) => {
    for (let k = from; k < to; k += 1) if (chars[k] !== "\n") chars[k] = " ";
  };
  const blank = (from, to) => {
    blankIn(code, from, to);
    blankIn(executable, from, to);
  };
  const previousSignificant = (pos) => {
    let k = pos - 1;
    while (k >= 0 && /\s/.test(code[k])) k -= 1;
    return k < 0 ? "" : code[k];
  };
  const readQuoted = (start) => {
    const quote = source[start];
    let k = start + 1;
    let value = "";
    while (k < source.length && source[k] !== quote && source[k] !== "\n") {
      if (source[k] === "\\") {
        value += source[k + 1] ?? "";
        k += 2;
        continue;
      }
      value += source[k];
      k += 1;
    }
    literals.push({ value, start, end: k + 1 });
    return k + 1;
  };
  const readRegex = (start) => {
    let k = start + 1;
    let inClass = false;
    while (k < source.length && source[k] !== "\n") {
      const c = source[k];
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        k += 1;
        while (/[a-z]/i.test(source[k] ?? "")) k += 1;
        return k;
      }
      k += 1;
    }
    return k;
  };
  function readTemplate(start) {
    let k = start + 1;
    let value = "";
    let textStart = k;
    while (k < source.length && source[k] !== "`") {
      if (source[k] === "\\") {
        value += source[k + 1] ?? "";
        k += 2;
        continue;
      }
      if (source[k] === "$" && source[k + 1] === "{") {
        blankIn(executable, textStart, k);
        k = readCode(k + 2, true);
        textStart = k;
        value += PLACEHOLDER;
        continue;
      }
      value += source[k];
      k += 1;
    }
    blankIn(executable, textStart, k);
    literals.push({ value, start, end: k + 1 });
    return k + 1;
  }
  function readCode(start, untilBrace) {
    let k = start;
    let depth = 0;
    while (k < source.length) {
      const c = source[k];
      const next = source[k + 1];
      if (c === "/" && next === "/") {
        const end = source.indexOf("\n", k);
        const stop = end === -1 ? source.length : end;
        blank(k, stop);
        k = stop;
      } else if (c === "/" && next === "*") {
        const end = source.indexOf("*/", k + 2);
        const stop = end === -1 ? source.length : end + 2;
        blank(k, stop);
        k = stop;
      } else if (c === '"' || c === "'") {
        k = readQuoted(k);
      } else if (c === "`") {
        k = readTemplate(k);
      } else if (c === "/" && REGEX_PRECEDERS.has(previousSignificant(k))) {
        k = readRegex(k);
      } else {
        if (untilBrace && c === "{") depth += 1;
        if (untilBrace && c === "}") {
          if (depth === 0) return k + 1;
          depth -= 1;
        }
        k += 1;
      }
    }
    return k;
  }
  readCode(0, false);
  return { code: code.join(""), executable: executable.join(""), literals };
}

/**
 * The surface manifests, read as text: this script runs without an install,
 * so it cannot import TypeScript. Only the fields the join needs.
 */
export function parseSurfaces(source) {
  const { code, literals } = scanSource(source);
  const start = code.indexOf("export const APP_SURFACES = [");
  const end = code.indexOf("] as const satisfies", start);
  if (start === -1 || end === -1) {
    throw new Error("APP_SURFACES array not found in app-surfaces.ts");
  }
  const literalAt = new Map(literals.map((l) => [l.start, l]));
  const objects = [];
  let depth = 0;
  let objectStart = -1;
  for (let k = code.indexOf("[", start) + 1; k < end; k += 1) {
    const literal = literalAt.get(k);
    if (literal) {
      // Brackets inside a string are not structure.
      k = literal.end - 1;
      continue;
    }
    const c = code[k];
    if (c === "{" || c === "[") {
      if (depth === 0 && c === "{") objectStart = k;
      depth += 1;
    } else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0 && c === "}") objects.push([objectStart, k + 1]);
    }
  }
  return objects.map(([from, to]) => {
    const inside = literals.filter((l) => l.start > from && l.start < to);
    const text = code.slice(from, to);
    const field = (name) => {
      const match = new RegExp(`\\b${name}:\\s*`).exec(text);
      if (!match) return undefined;
      const at = from + match.index + match[0].length;
      return inside.find((l) => l.start === at)?.value;
    };
    const arrayField = (name) => {
      const match = new RegExp(`\\b${name}:\\s*\\[`).exec(text);
      if (!match) return [];
      const open = from + match.index + match[0].length;
      const close = code.indexOf("]", open);
      return inside
        .filter((l) => l.start >= open && l.start < close)
        .map((l) => l.value);
    };
    const id = field("id");
    if (!id) throw new Error(`surface without an id near offset ${from}`);
    return {
      id,
      canonicalPath: field("canonicalPath") ?? "",
      routePatterns: arrayField("routePatterns"),
    };
  });
}

/**
 * A navigation target as logical route segments: `/p/<project>`, query and
 * hash removed. Null when the value names no screen:
 *
 *   - a literal `scheme://host` URL is a fixture or third-party page; specs
 *     reach the app through the config's `baseURL`, with relative paths;
 *   - the root path (and a bare project root) is where every spec boots the
 *     app, and where the fixture servers serve their own page, so landing
 *     there verifies no particular screen.
 */
export function destinationSegments(raw) {
  let path = raw.split(/[?#]/)[0];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  // `${origin}/login`: an interpolated origin in front of an absolute path.
  if (path.startsWith(`${PLACEHOLDER}/`)) path = path.slice(PLACEHOLDER.length);
  if (/\s/.test(path)) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "p" && segments.length >= 2) segments.splice(0, 2);
  return segments.length ? segments : null;
}

function matchPattern(pattern, segments) {
  const parts = pattern === "/" ? [] : pattern.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;
  let quality = "exact";
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const segment = segments[i];
    if (part.startsWith(":")) {
      if (!segment) return null;
      quality = "param";
    } else if (segment !== part) {
      // `swarms${suffix}`: a static segment with an interpolated tail.
      const stem = segment.split(PLACEHOLDER)[0];
      if (!segment.includes(PLACEHOLDER) || stem !== part) return null;
    }
  }
  return quality;
}

/** The surface a destination renders, preferring a static match to a `:param` one. */
export function matchSurface(surfaces, segments) {
  let paramMatch = null;
  for (const surface of surfaces) {
    for (const pattern of surface.routePatterns) {
      const quality = matchPattern(pattern, segments);
      if (quality === "exact") return surface.id;
      if (quality === "param" && !paramMatch) paramMatch = surface.id;
    }
  }
  return paramMatch;
}

/** Surfaces an E2E spec navigates to. */
export function navigatedSurfaces(source, surfaces) {
  const { code, literals } = scanSource(source);
  const literalAt = new Map(literals.map((l) => [l.start, l]));
  const found = new Set();
  let dataDriven = false;
  for (const match of code.matchAll(/\bgoto\(\s*/g)) {
    const literal = literalAt.get(match.index + match[0].length);
    const segments = literal ? destinationSegments(literal.value) : null;
    const id = segments ? matchSurface(surfaces, segments) : null;
    if (id) found.add(id);
    const interpolatedRoute =
      literal?.value.includes(PLACEHOLDER) &&
      (!segments || segments.some((s) => s.includes(PLACEHOLDER)));
    if (!literal || interpolatedRoute) dataDriven = true;
  }
  if (dataDriven) {
    for (const literal of literals) {
      if (!/^[\w./:*-]+$/.test(literal.value)) continue;
      const segments = destinationSegments(literal.value);
      const id = segments ? matchSurface(surfaces, segments) : null;
      if (id) found.add(id);
    }
  }
  return found;
}

/** `// @surface <id>` tags, one id per comment line. */
export function surfaceTags(source) {
  return [
    ...source.matchAll(/^\s*(?:\/\/|\*)\s*@surface\s+([\w-]+)\s*$/gm),
  ].map((m) => m[1]);
}

/**
 * Blank block comments and whole-line comments. JSX text can hold quotes and
 * `//`, so the string-aware {@link scanSource} would misread it.
 */
function stripLineComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "");
}

const IMPORT_SPECIFIERS = [
  /\b(?:import|export)\s+(?:type\s+)?[\w*\s{},$]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

const isTypeOnly = (statement) => {
  if (/^(?:import|export)\s+type\s/.test(statement)) return true;
  const named = /^(?:import|export)\s*\{([^}]*)\}\s*from/.exec(statement);
  const bindings = (named?.[1] ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  return bindings.length > 0 && bindings.every((b) => b.startsWith("type "));
};

/** Value imports of a module (type-only imports exercise nothing). */
export function importSpecifiers(source) {
  const { executable: code } = scanSource(source);
  const out = [];
  for (const re of IMPORT_SPECIFIERS) {
    for (const match of code.matchAll(re)) {
      if (isTypeOnly(match[0])) continue;
      out.push(match[1]);
    }
  }
  return out;
}

/**
 * Top-level declarations of a module by name → their text. Relies on
 * declarations starting in column 0, which Prettier guarantees.
 */
export function topLevelDeclarations(source) {
  const lines = source.split("\n");
  const out = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const match =
      /^(?:export\s+)?(?:default\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/.exec(
        lines[i],
      );
    if (!match) continue;
    let j = i + 1;
    while (j < lines.length && !/^[^\s})\]]/.test(lines[j])) j += 1;
    out.set(match[1] ?? match[2], lines.slice(i, j).join("\n"));
  }
  return out;
}

/** Imported local name → its specifier and the name the module exports. */
export function importBindings(source) {
  const out = new Map();
  const { executable: code } = scanSource(source);
  for (const match of code.matchAll(
    /\bimport\s+(?!type\s)([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g,
  )) {
    const specifier = match[3];
    if (match[1]) out.set(match[1], { specifier, imported: "default" });
    for (const raw of (match[2] ?? "").split(",")) {
      const spec = raw.trim();
      if (!spec || spec.startsWith("type ")) continue;
      const [imported, local = imported] = spec
        .split(/\s+as\s+/)
        .map((name) => name.trim());
      out.set(local, { specifier, imported });
    }
  }
  return out;
}

const jsxTags = (text) =>
  [...stripLineComments(text).matchAll(/<([A-Z][\w$]*)/g)].map((m) => m[1]);

/** `ROUTE_ELEMENTS` key → the JSX tags its entry renders. */
export function routeElementTags(routerSource) {
  const start = routerSource.indexOf("const ROUTE_ELEMENTS");
  const end = routerSource.indexOf("\n};", start);
  if (start === -1 || end === -1) return new Map();
  const out = new Map();
  let current = null;
  for (const line of routerSource.slice(start, end).split("\n")) {
    const key = /^ {2}(?:"([^"]+)"|([A-Za-z][\w-]*)):/.exec(line);
    if (key) {
      current = key[1] ?? key[2];
      out.set(current, []);
    }
    if (current && !/^\s*\/\//.test(line))
      out.get(current).push(...jsxTags(line));
  }
  return out;
}

/**
 * Each surface's root modules: the files of the components its routes render,
 * following `*Route` functions defined in `App.tsx` down to imported files.
 */
export function surfaceRoots({
  surfaces,
  routerSource,
  appSource,
  resolve: res,
}) {
  const routerImports = importBindings(routerSource);
  const appImports = importBindings(appSource);
  const appDeclarations = topLevelDeclarations(appSource);
  const routeTags = routeElementTags(routerSource);
  const roots = new Map(surfaces.map((s) => [s.id, new Set()]));

  const collect = (tags, imports, fromRel, into, seen) => {
    for (const tag of tags) {
      const key = `${fromRel}\0${tag}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const binding = imports.get(tag);
      const specifier = binding?.specifier;
      const fromApp = specifier && /^\.\/App(?:\.tsx)?$/.test(specifier);
      if (fromApp || (!specifier && appDeclarations.has(tag))) {
        const body = appDeclarations.get(fromApp ? binding.imported : tag);
        if (body)
          collect(jsxTags(body), appImports, "client/src/App.tsx", into, seen);
        continue;
      }
      const file = specifier ? res(fromRel, specifier) : null;
      // Design-system primitives (an empty state, an error boundary) wrap
      // screens; they are never what a screen is.
      if (file && !file.startsWith(DESIGN_SYSTEM_DIR)) into.add(file);
    }
  };

  for (const [path, tags] of routeTags) {
    // Redirects, embeds and callbacks render no surface; the route-coverage
    // test already keeps every screen route inside some `routePatterns`.
    const owner = surfaces.find((s) => s.routePatterns.includes(path));
    if (!owner) continue;
    collect(
      tags,
      routerImports,
      "client/src/router.tsx",
      roots.get(owner.id),
      new Set(),
    );
  }
  return roots;
}

/**
 * Test-only harness pages (`__e2e/<name>` in `router.tsx`, dev builds only) →
 * the module each lazily loads. A spec that opens one exercises whatever
 * surface code the harness mounts.
 */
export function harnessModules(routerSource) {
  const out = new Map();
  for (const match of routerSource.matchAll(
    /path:\s*"(__e2e\/[^"]+)"[\s\S]{0,400}?import\(\s*"([^"]+)"\s*\)/g,
  )) {
    out.set(match[1], match[2]);
  }
  return out;
}

/**
 * Module → the surfaces it belongs to. A root component belongs to the
 * surfaces that render it, unless more than {@link MAX_SURFACES_PER_ROOT} do
 * (route chrome: redirects, error boundaries, page headers). Any other module
 * belongs to a surface only when that surface alone imports it, directly or
 * not; anything two surfaces reach is shared and counts for neither.
 */
export function moduleOwners(graph, roots) {
  const reachedBy = new Map();
  for (const [id, starts] of roots) {
    const stack = [...starts];
    const seen = new Set(starts);
    while (stack.length) {
      const file = stack.pop();
      if (!reachedBy.has(file)) reachedBy.set(file, new Set());
      reachedBy.get(file).add(id);
      for (const next of graph.get(file) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
  }
  const renderedBy = new Map();
  for (const [id, starts] of roots) {
    for (const file of starts) {
      if (!renderedBy.has(file)) renderedBy.set(file, []);
      renderedBy.get(file).push(id);
    }
  }
  const owners = new Map();
  for (const [file, ids] of renderedBy) {
    if (ids.length <= MAX_SURFACES_PER_ROOT) owners.set(file, ids);
  }
  for (const [file, ids] of reachedBy) {
    if (ids.size === 1 && !renderedBy.has(file)) owners.set(file, [...ids]);
  }
  return owners;
}
