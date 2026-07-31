import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import {
  parseOAuthImplementation,
  readScenario,
  readTrace,
  registerOAuthTraceCommands,
} from "../src/commands/oauth-trace.js";
import { CliError } from "../src/lib/output.js";

// `import.meta.dirname` only landed in Node 20.11, and the package declares
// `>=20.0.0`.
const HERE = dirname(fileURLToPath(import.meta.url));

const FIXTURE_TRACE = join(
  HERE,
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

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "mcpjam-hp44-")), name);
}

/**
 * The real command tree, minus the network. `--format` lives on the root program
 * in production, and `traceFormat` reads it through `optsWithGlobals`, so the
 * stand-in root has to carry it too or the format would fall back to whether the
 * test runner happens to own a TTY.
 */
function buildTraceProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--format <format>", "json | human");
  const oauth = program.command("oauth");
  registerOAuthTraceCommands(oauth);
  return program;
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
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

test("readTrace rejects a structurally invalid trace as a CliError, not a TypeError", () => {
  // `{"traceVersion": 1}` clears the version check and used to reach the drift
  // walk, which mapped over an undefined `wire` and threw a raw TypeError — the
  // one malformed input that escaped the CliError contract every other one gets.
  for (const body of [
    { traceVersion: 1 },
    { traceVersion: 1, wire: "not-an-array", observations: {}, scenario: {} },
    { traceVersion: 1, wire: [], scenario: {} },
    { traceVersion: 1, wire: [], observations: {} },
  ]) {
    const path = tempFile("structurally-invalid.json", body);
    assert.throws(
      () => readTrace(path, "Golden trace"),
      (error: unknown) =>
        error instanceof CliError &&
        /not a structurally valid golden trace/.test(error.message),
      `expected a CliError for ${JSON.stringify(body)}`,
    );
  }
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

test("to-profile prints the profile to stdout when --out is absent", async () => {
  const program = buildTraceProgram();
  const output = await captureStdout(async () => {
    await program.parseAsync(
      ["--format", "json", "oauth", "trace", "to-profile", "--trace", FIXTURE_TRACE],
      { from: "user" },
    );
  });

  const printed = JSON.parse(output) as Record<string, unknown>;
  assert.ok(printed.dcrIdentity, "the profile itself should be on stdout");
});

test("to-profile --out keeps the profile off stdout", async () => {
  // The option is documented as writing the profile INSTEAD of printing it, so a
  // caller piping stdout into a second tool must not also receive the payload.
  const out = tempPath("profile.json");
  const program = buildTraceProgram();
  const output = await captureStdout(async () => {
    await program.parseAsync(
      [
        "--format",
        "json",
        "oauth",
        "trace",
        "to-profile",
        "--trace",
        FIXTURE_TRACE,
        "--out",
        out,
      ],
      { from: "user" },
    );
  });

  const written = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
  assert.ok(written.dcrIdentity, "the profile should be in the --out file");

  const printed = JSON.parse(output) as Record<string, unknown>;
  assert.deepEqual(Object.keys(printed).sort(), ["path", "traceId"]);
  assert.equal(printed.path, out);
});

test("capture rejects --client-secret without --client-id", async () => {
  // The secret can only travel on the preregistered client block, which exists
  // only when a client id was supplied; dropping it silently would surface as a
  // confusing token-leg failure instead.
  const scenario = tempFile("scenario.json", {
    scenarioId: "in-memory-dcr-authcode-prm",
    mcpServerUrl: "https://mcp.example.test/mcp",
    capabilities: {
      publishesPrm: true,
      supportsDcr: true,
      supportsCimd: false,
      codeChallengeMethods: ["S256"],
      asMetadataDocuments: ["/.well-known/oauth-authorization-server"],
      challengesUnauthenticated: true,
    },
  });

  const program = buildTraceProgram();
  await assert.rejects(
    program.parseAsync(
      [
        "oauth",
        "trace",
        "capture",
        "--server-url",
        "https://mcp.example.test/mcp",
        "--scenario",
        scenario,
        "--out",
        tempPath("trace.json"),
        "--client-secret",
        "s3cret",
      ],
      { from: "user" },
    ),
    (error: unknown) =>
      error instanceof CliError &&
      error.code === "USAGE_ERROR" &&
      /client secret requires --client-id/.test(error.message),
  );
});

test("capture reads the client secret from the environment too", async () => {
  // An argv secret is readable by anyone who can list processes, so the env var is
  // the documented alternative — and it has to hit the SAME guard, or the safer
  // path would be the one that silently drops the secret at the token leg.
  const scenario = tempFile("scenario.json", {
    scenarioId: "in-memory-dcr-authcode-prm-mcp2025-11-25",
    mcpServerUrl: "https://mcp.example.test/mcp",
    capabilities: {
      publishesPrm: true,
      supportsDcr: true,
      supportsCimd: false,
      codeChallengeMethods: ["S256"],
      serverProtocolVersion: "2025-11-25",
      asMetadataDocuments: ["/.well-known/oauth-authorization-server"],
      challengesUnauthenticated: true,
    },
  });

  const previous = process.env.MCPJAM_OAUTH_CLIENT_SECRET;
  process.env.MCPJAM_OAUTH_CLIENT_SECRET = "s3cret-from-env";
  try {
    const program = buildTraceProgram();
    await assert.rejects(
      program.parseAsync(
        [
          "oauth",
          "trace",
          "capture",
          "--server-url",
          "https://mcp.example.test/mcp",
          "--scenario",
          scenario,
          "--out",
          tempPath("trace.json"),
        ],
        { from: "user" },
      ),
      (error: unknown) =>
        error instanceof CliError &&
        error.code === "USAGE_ERROR" &&
        /client secret requires --client-id/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.MCPJAM_OAUTH_CLIENT_SECRET;
    else process.env.MCPJAM_OAUTH_CLIENT_SECRET = previous;
  }
});
