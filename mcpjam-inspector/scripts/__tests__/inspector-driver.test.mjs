import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactSlug,
  classifyIssues,
  describeStep,
  displayPath,
  findAllowRule,
  formatPageReport,
  formatSweepLine,
  isFailingKind,
  kindMatches,
  normalizeSteps,
  oneLine,
  parseAccessToken,
  parseAllowlist,
  parseSelector,
  redactStep,
  redactText,
  redactUrl,
  resolveTarget,
  routeMismatch,
  withStartStep,
} from "../lib/inspector-driver-core.mjs";

const BASE = "http://localhost:5174";
const SURFACES = [
  {
    id: "servers",
    title: "Connect",
    canonicalPath: "/servers",
    navSegments: ["servers", "client-config"],
  },
  {
    id: "hosts",
    title: "Hosts",
    canonicalPath: "/hosts",
    navSegments: ["clients"],
  },
  {
    id: "support",
    title: "Support",
    canonicalPath: "/settings/support",
    navSegments: ["support"],
  },
];
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

test("a surface resolves by id, nav segment or title", () => {
  assert.deepEqual(resolveTarget("servers", SURFACES, BASE), {
    url: `${BASE}/servers`,
    surfaceId: "servers",
  });
  assert.equal(resolveTarget("clients", SURFACES, BASE).surfaceId, "hosts");
  assert.equal(resolveTarget("Connect", SURFACES, BASE).surfaceId, "servers");
  assert.equal(
    resolveTarget("support", SURFACES, BASE).url,
    `${BASE}/settings/support`,
  );
});

test("a path or URL passes through without a surface", () => {
  assert.deepEqual(resolveTarget("/p/abc/servers", SURFACES, BASE), {
    url: `${BASE}/p/abc/servers`,
    surfaceId: null,
  });
  assert.deepEqual(resolveTarget("https://example.test/x", SURFACES, BASE), {
    url: "https://example.test/x",
    surfaceId: null,
  });
});

test("an unknown surface names the near misses", () => {
  assert.throws(
    () => resolveTarget("server", SURFACES, BASE),
    /Did you mean: servers/,
  );
  assert.throws(
    () => resolveTarget("zzz", SURFACES, BASE),
    /Unknown surface "zzz"/,
  );
});

test("every surface in the feature map resolves to its own canonical path", async () => {
  const { listAppSurfaces } = await import("../../shared/app-surfaces.ts");
  const surfaces = listAppSurfaces();
  for (const surface of surfaces) {
    const { url, surfaceId } = resolveTarget(surface.id, surfaces, BASE);
    assert.equal(surfaceId, surface.id);
    assert.equal(new URL(url).pathname, surface.canonicalPath);
  }
});

test("an access token is read bare or out of an access link", () => {
  assert.equal(parseAccessToken(TOKEN), TOKEN);
  assert.equal(
    parseAccessToken(`http://localhost:5173/#token=${TOKEN}&tab=servers`),
    TOKEN,
  );
  assert.equal(parseAccessToken("short"), null);
  assert.equal(parseAccessToken("http://localhost:5173/"), null);
});

test("steps normalize from an array or an object with a start", () => {
  assert.deepEqual(
    normalizeSteps([
      { click: "testid=add" },
      { fill: "label=URL", value: "x" },
    ]),
    {
      start: undefined,
      steps: [
        { action: "click", target: "testid=add" },
        { action: "fill", target: "label=URL", value: "x" },
      ],
    },
  );
  assert.deepEqual(
    normalizeSteps({
      start: "servers",
      steps: [{ press: "Enter", on: "label=URL" }],
    }),
    {
      start: "servers",
      steps: [{ action: "press", target: "Enter", on: "label=URL" }],
    },
  );
});

test("a malformed step says which step and why", () => {
  assert.throws(() => normalizeSteps([]), /non-empty array/);
  assert.throws(
    () => normalizeSteps([{ click: "a", hover: "b" }]),
    /step 1: name exactly one action/,
  );
  assert.throws(
    () => normalizeSteps([{ click: "a" }, { fill: "label=x" }]),
    /step 2: "fill" needs a string "value"/,
  );
  assert.throws(
    () => normalizeSteps([{ waitFor: "a", state: "gone" }]),
    /"state" must be/,
  );
});

test("a run without a leading goto needs a start surface", () => {
  const steps = [{ action: "click", target: "a" }];
  assert.deepEqual(withStartStep(steps, "servers"), [
    { action: "goto", target: "servers" },
    ...steps,
  ]);
  const opens = [{ action: "goto", target: "hosts" }];
  assert.equal(withStartStep(opens, "servers"), opens);
  assert.throws(() => withStartStep(steps, undefined), /first step must be/);
});

test("selector shorthands map to getBy calls and the rest pass through", () => {
  assert.deepEqual(parseSelector("testid=app-shell"), {
    by: "testid",
    value: "app-shell",
  });
  assert.deepEqual(parseSelector("label=Server URL"), {
    by: "label",
    value: "Server URL",
  });
  assert.deepEqual(parseSelector('role=button[name="Add"]'), {
    by: "selector",
    value: 'role=button[name="Add"]',
  });
});

test("allowlist rules need a match and a reason", () => {
  assert.throws(
    () => parseAllowlist({ rules: [{ match: "x" }] }),
    /"reason" is required/,
  );
  assert.throws(
    () => parseAllowlist({ rules: [{ reason: "r" }] }),
    /"match" must be/,
  );
  assert.throws(() => parseAllowlist({}), /expected \{ "rules"/);
  const [rule] = parseAllowlist({
    rules: [{ match: "favicon", reason: "dev only" }],
  });
  assert.equal(rule.kind, "*");
});

test("allowlist kinds match exactly, by HTTP family, or all", () => {
  assert.equal(kindMatches("*", "page-error"), true);
  assert.equal(kindMatches("http-4xx", "http-404"), true);
  assert.equal(kindMatches("http-4xx", "http-500"), false);
  assert.equal(kindMatches("console-error", "console-warning"), false);
  const rules = parseAllowlist({
    rules: [{ kind: "http-4xx", match: "/api/optional", reason: "probe" }],
  });
  assert.ok(
    findAllowRule(rules, {
      kind: "http-401",
      text: "GET http://x/api/optional",
    }),
  );
  assert.equal(
    findAllowRule(rules, {
      kind: "http-500",
      text: "GET http://x/api/optional",
    }),
    undefined,
  );
});

test("the shipped allowlist parses and every rule says why", () => {
  const path = join(
    import.meta.dirname,
    "..",
    "inspector-driver.allowlist.json",
  );
  const rules = parseAllowlist(JSON.parse(readFileSync(path, "utf8")), path);
  for (const rule of rules) assert.ok(rule.reason.length > 10);
});

test("failing kinds are errors, failed requests and 4xx/5xx, never warnings", () => {
  for (const kind of [
    "console-error",
    "page-error",
    "request-failed",
    "http-404",
    "http-503",
    "not-found",
    "wrong-route",
  ]) {
    assert.equal(isFailingKind(kind), true, kind);
  }
  for (const kind of ["console-warning", "http-304", "http-200"]) {
    assert.equal(isFailingKind(kind), false, kind);
  }
});

test("events split into issues, warnings and allowed, with repeats counted", () => {
  const rules = parseAllowlist({
    rules: [
      { kind: "http-4xx", match: "favicon", reason: "dev server has none" },
    ],
  });
  const classified = classifyIssues(
    [
      { kind: "console-error", text: "boom\n  at x" },
      { kind: "console-error", text: "boom   at x" },
      { kind: "console-warning", text: "deprecated" },
      { kind: "http-404", text: "GET http://x/favicon.ico" },
    ],
    rules,
  );
  assert.deepEqual(classified.issues, [
    { kind: "console-error", text: "boom at x", count: 2 },
  ]);
  assert.deepEqual(classified.warnings, [
    { kind: "console-warning", text: "deprecated", count: 1 },
  ]);
  assert.equal(classified.allowed[0].reason, "dev server has none");
});

test("report text is one line without terminal colors", () => {
  assert.equal(
    oneLine("Timeout.\n\u001b[2m - waiting for x\u001b[22m"),
    "Timeout. - waiting for x",
  );
  assert.equal(oneLine("x".repeat(30), 10), "xxxxxxx...");
});

test("credentials in URLs are redacted", () => {
  assert.equal(
    redactUrl("http://x/cb?code=abc&state=1&access_token=t"),
    "http://x/cb?code=REDACTED&state=1&access_token=REDACTED",
  );
  assert.equal(redactUrl(`http://x/#token=${TOKEN}`), "http://x/#REDACTED");
  assert.equal(redactUrl("not a url"), "not a url");
});

test("fill values and URL credentials stay out of steps and free text", () => {
  const fill = { action: "fill", target: "label=Password", value: "hunter2" };
  assert.equal(describeStep(fill), "fill label=Password (value hidden)");
  assert.deepEqual(redactStep(fill), { ...fill, value: "[redacted]" });
  assert.deepEqual(
    redactStep({ action: "goto", target: "/cb?code=abc&page=2" }),
    { action: "goto", target: "/cb?code=REDACTED&page=2" },
  );
  assert.deepEqual(
    redactStep({ action: "goto", target: `http://x/#token=${TOKEN}` }),
    { action: "goto", target: "http://x/#REDACTED" },
  );
  assert.deepEqual(redactStep({ action: "goto", target: "servers" }), {
    action: "goto",
    target: "servers",
  });
  assert.equal(
    redactText(
      'locator.fill("hunter2") at http://x/a?session=s1, then ws://y/?key=k',
      ["hunter2"],
    ),
    'locator.fill("[redacted]") at http://x/a?session=REDACTED, then ws://y/?key=REDACTED',
  );
  const classified = classifyIssues(
    [{ kind: "page-error", text: "boom at http://x/?token=t" }],
    [],
  );
  assert.equal(classified.issues[0].text, "boom at http://x/?token=REDACTED");
});

test("a page that lands off the requested route is named, a match is not", () => {
  const evals = {
    id: "evals",
    canonicalPath: "/evals",
    routePatterns: ["evals", "evals/suite/:suiteId"],
  };
  const home = { id: "home", canonicalPath: "/home", routePatterns: ["/"] };
  const at = (finalUrl, surface, requestedUrl = `${BASE}/evals`) =>
    routeMismatch({ requestedUrl, finalUrl, surface });
  assert.equal(at(`${BASE}/p/abc/evals`, evals), null);
  assert.equal(at(`${BASE}/p/abc/evals/suite/s1`, evals), null);
  assert.equal(at(`${BASE}/p/abc`, home, `${BASE}/home`), null);
  assert.equal(
    at(`${BASE}/p/abc/servers`, evals),
    `asked for surface evals (/evals), landed on ${BASE}/p/<id>/servers`,
  );
  assert.match(at(`${BASE}/p/abc/evals/suite`, evals), /landed on/);
  assert.match(at("http://elsewhere/evals", evals), /landed on/);
  assert.equal(at(`${BASE}/p/abc/tools`, null, `${BASE}/tools?x=1`), null);
  assert.equal(
    at(`${BASE}/sign-in`, null, `${BASE}/tools?code=c`),
    `asked for ${BASE}/tools?code=REDACTED, landed on ${BASE}/sign-in`,
  );
});

test("the page report is greppable and ends in RESULT", () => {
  const text = formatPageReport({
    label: "OPEN servers",
    finalUrl: "http://localhost:5174/p/abc/servers",
    title: "MCPJam",
    seconds: 1.25,
    steps: [
      {
        index: 1,
        action: "click",
        target: "testid=x",
        ok: false,
        error: "Timeout\nwaiting",
      },
    ],
    classified: {
      issues: [{ kind: "http-500", text: "GET /api/x", count: 2 }],
      warnings: [],
      allowed: [{ kind: "http-404", text: "favicon", count: 1, reason: "r" }],
    },
    artifacts: { shot: "/tmp/servers.png" },
  });
  const lines = text.split("\n");
  assert.equal(
    lines[0],
    "OPEN servers -> http://localhost:5174/p/abc/servers  (1.3s)",
  );
  assert.match(text, /step {2}1 FAIL click testid=x {2}Timeout waiting/);
  assert.match(text, /^ {2}ISSUE {3}http-500 {8}GET \/api\/x \(x2\)$/m);
  assert.match(text, /allowed 1 \(http-404 x1\)/);
  assert.match(text, /shot {4}\/tmp\/servers\.png/);
  assert.equal(lines.at(-1), "RESULT fail issues=2 warnings=0 allowed=1");
});

test("a sweep row is one line with the first issue", () => {
  const ok = formatSweepLine(
    {
      surfaceId: "home",
      finalPath: "/p/<id>/home",
      seconds: 2,
      classified: { issues: [], warnings: [], allowed: [] },
    },
    8,
  );
  assert.match(ok, /^ok +home +\/p\/<id>\/home +issues=0 +warnings=0 +2\.0s$/);
  const fail = formatSweepLine(
    {
      surfaceId: "hosts",
      finalPath: null,
      seconds: 1,
      classified: {
        issues: [{ kind: "page-error", text: "TypeError: x", count: 1 }],
        warnings: [],
        allowed: [],
      },
    },
    8,
  );
  assert.match(
    fail,
    /^FAIL +hosts .*\(no page\).*first=page-error: TypeError: x$/,
  );
  assert.equal(fail.includes("\n"), false);
});

test("paths shorten the project id and slugs are file-safe", () => {
  assert.equal(displayPath("http://x/p/k57abc/servers?x=1"), "/p/<id>/servers");
  assert.equal(displayPath("http://x/settings"), "/settings");
  assert.equal(displayPath(null), null);
  assert.equal(artifactSlug("Step 2: Add server!"), "step-2-add-server");
  assert.equal(artifactSlug("///"), "page");
});
