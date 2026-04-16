import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadSuiteConfig } from "../src/lib/config-file.js";
import { CliError } from "../src/lib/output.js";

function withTempFile(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cli-config-test-"));
  const path = join(dir, "config.json");
  writeFileSync(path, content, "utf-8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadSuiteConfig loads a valid config file", () => {
  const config = {
    serverUrl: "https://mcp.example.com/mcp",
    flows: [
      {
        protocolVersion: "2025-11-25",
        registrationStrategy: "cimd",
      },
    ],
  };

  withTempFile(JSON.stringify(config), (path) => {
    const result = loadSuiteConfig(path);
    assert.equal(result.serverUrl, "https://mcp.example.com/mcp");
    assert.equal(result.flows.length, 1);
    assert.equal(result.flows[0].registrationStrategy, "cimd");
  });
});

test("loadSuiteConfig throws on missing file", () => {
  assert.throws(
    () => loadSuiteConfig("/nonexistent/path/config.json"),
    (error) => error instanceof CliError && error.message.includes("Cannot read"),
  );
});

test("loadSuiteConfig throws on invalid JSON", () => {
  withTempFile("not json {{{", (path) => {
    assert.throws(
      () => loadSuiteConfig(path),
      (error) => error instanceof CliError && error.message.includes("not valid JSON"),
    );
  });
});

test("loadSuiteConfig throws on missing serverUrl", () => {
  withTempFile(JSON.stringify({ flows: [{ protocolVersion: "2025-11-25", registrationStrategy: "dcr" }] }), (path) => {
    assert.throws(
      () => loadSuiteConfig(path),
      (error) => error instanceof CliError && error.message.includes("serverUrl"),
    );
  });
});

test("loadSuiteConfig throws on empty flows", () => {
  withTempFile(JSON.stringify({ serverUrl: "https://example.com/mcp", flows: [] }), (path) => {
    assert.throws(
      () => loadSuiteConfig(path),
      (error) => error instanceof CliError && error.message.includes("non-empty"),
    );
  });
});

test("loadSuiteConfig throws on invalid protocol version", () => {
  const config = {
    serverUrl: "https://example.com/mcp",
    flows: [{ protocolVersion: "invalid", registrationStrategy: "dcr" }],
  };

  withTempFile(JSON.stringify(config), (path) => {
    assert.throws(
      () => loadSuiteConfig(path),
      (error) =>
        error instanceof CliError && error.message.includes("protocolVersion"),
    );
  });
});

test("loadSuiteConfig throws on invalid registration strategy", () => {
  const config = {
    serverUrl: "https://example.com/mcp",
    flows: [{ protocolVersion: "2025-11-25", registrationStrategy: "invalid" }],
  };

  withTempFile(JSON.stringify(config), (path) => {
    assert.throws(
      () => loadSuiteConfig(path),
      (error) =>
        error instanceof CliError && error.message.includes("registrationStrategy"),
    );
  });
});

test("loadSuiteConfig accepts flows that inherit from defaults", () => {
  const config = {
    serverUrl: "https://example.com/mcp",
    defaults: {
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
    },
    flows: [{ label: "inherits defaults" }],
  };

  withTempFile(JSON.stringify(config), (path) => {
    const result = loadSuiteConfig(path);
    assert.equal(result.flows[0].label, "inherits defaults");
  });
});

test("loadSuiteConfig validates auth mode enum", () => {
  const config = {
    serverUrl: "https://example.com/mcp",
    flows: [
      {
        protocolVersion: "2025-06-18",
        registrationStrategy: "dcr",
        auth: { mode: "invalid_mode" },
      },
    ],
  };

  withTempFile(JSON.stringify(config), (path) => {
    assert.throws(
      () => loadSuiteConfig(path),
      (error) =>
        error instanceof CliError && error.message.includes("auth.mode"),
    );
  });
});
