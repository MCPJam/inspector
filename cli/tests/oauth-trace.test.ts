import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseOAuthImplementation,
  readScenario,
  readTrace,
} from "../src/commands/oauth-trace.js";
import { CliError } from "../src/lib/output.js";

const FIXTURE_TRACE = join(
  import.meta.dirname,
  "..",
  "..",
  "sdk",
  "tests",
  "fixtures",
  "golden-traces",
  "mcpjam-in-memory-dcr-authcode-prm.json",
);

function tempFile(name: string, contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpjam-hp44-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(contents, null, 2), "utf8");
  return path;
}

test("parseOAuthImplementation accepts first-party", () => {
  assert.deepEqual(parseOAuthImplementation("first-party"), {
    kind: "first-party",
  });
});

test("parseOAuthImplementation parses a resolved dependency", () => {
  // Most source-verified clients inherit OAuth from a dependency, so the resolved
  // version has to come from a lockfile rather than a manifest range.
  assert.deepEqual(parseOAuthImplementation("rmcp@2.2.0:Cargo.lock"), {
    kind: "dependency",
    package: "rmcp",
    version: "2.2.0",
    resolvedFrom: "Cargo.lock",
  });
});

test("parseOAuthImplementation handles a scoped package name", () => {
  assert.deepEqual(
    parseOAuthImplementation(
      "@modelcontextprotocol/sdk@1.29.0:package-lock.json",
    ),
    {
      kind: "dependency",
      package: "@modelcontextprotocol/sdk",
      version: "1.29.0",
      resolvedFrom: "package-lock.json",
    },
  );
});

test("parseOAuthImplementation returns undefined when omitted", () => {
  assert.equal(parseOAuthImplementation(undefined), undefined);
});

test("parseOAuthImplementation rejects a malformed spec", () => {
  assert.throws(() => parseOAuthImplementation("rmcp-2.2.0"), CliError);
});

test("readTrace loads the committed golden trace", () => {
  const trace = readTrace(FIXTURE_TRACE, "Golden trace");
  assert.equal(trace.traceVersion, 1);
  assert.equal(trace.subject.hostId, "mcpjam");
  assert.deepEqual(trace.observations.legOrder, [
    "mcp-unauthenticated",
    "prm-discovery",
    "as-metadata-discovery",
    "dcr-register",
    "authorize",
    "token",
    "mcp-initialize",
  ]);
});

test("readTrace rejects a file that is not a golden trace", () => {
  const path = tempFile("not-a-trace.json", { hello: "world" });
  assert.throws(() => readTrace(path, "Golden trace"), CliError);
});

test("readTrace rejects a trace whose observations no longer follow from its wire", () => {
  // A hand-edited artifact would skew every downstream verdict, so it is rejected
  // rather than trusted. This guard caught a hand-edit during development.
  const trace = readTrace(FIXTURE_TRACE, "Golden trace");
  const tampered = {
    ...trace,
    wire: trace.wire.map((exchange) => {
      const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
      if (next.request.body?.encoding === "form") {
        delete next.request.body.fields.resource;
      }
      return next;
    }),
  };

  const path = tempFile("tampered.json", tampered);
  assert.throws(
    () => readTrace(path, "Golden trace"),
    (error: unknown) =>
      error instanceof CliError &&
      /do not follow from its own wire/.test(error.message),
  );
});

test("readTrace surfaces a missing file as a validation error", () => {
  assert.throws(
    () => readTrace(join(tmpdir(), "definitely-not-here-hp44.json"), "Golden trace"),
    CliError,
  );
});

test("readScenario requires the capabilities block that gates every diff", () => {
  // Without knowing whether the server published a PRM document, the harness
  // cannot tell a client that correctly omits `resource` from one that is broken.
  const path = tempFile("scenario.json", {
    scenarioId: "x",
    mcpServerUrl: "https://mcp.example.test/mcp",
  });
  assert.throws(
    () => readScenario(path),
    (error: unknown) =>
      error instanceof CliError && /capabilities/.test(error.message),
  );
});

test("readScenario accepts a complete scenario", () => {
  const path = tempFile("scenario.json", {
    scenarioId: "in-memory-dcr-authcode-prm",
    mcpServerUrl: "https://mcp.example.test/mcp",
    authorizationServerUrl: "https://as.example.test",
    capabilities: {
      publishesPrm: true,
      prmResource: "https://mcp.example.test/mcp",
      supportsDcr: true,
      supportsCimd: false,
      codeChallengeMethods: ["S256"],
      asMetadataDocuments: ["/.well-known/oauth-authorization-server"],
      challengesUnauthenticated: true,
    },
  });

  const scenario = readScenario(path);
  assert.equal(scenario.scenarioId, "in-memory-dcr-authcode-prm");
  assert.equal(scenario.capabilities.publishesPrm, true);
});
