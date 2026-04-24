import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  loadAppsSuiteConfig,
  loadOAuthSuiteConfig,
  loadProtocolSuiteConfig,
  loadSuiteConfig,
} from "../src/lib/config-file.js";
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

test("loadOAuthSuiteConfig loads a valid config file", () => {
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
    const result = loadOAuthSuiteConfig(path);
    assert.equal(result.serverUrl, "https://mcp.example.com/mcp");
    assert.equal(result.flows.length, 1);
    assert.equal(result.flows[0].registrationStrategy, "cimd");
  });
});

test("loadSuiteConfig remains an alias for the OAuth suite loader", () => {
  const config = {
    serverUrl: "https://mcp.example.com/mcp",
    flows: [
      {
        protocolVersion: "2025-11-25",
        registrationStrategy: "dcr",
      },
    ],
  };

  withTempFile(JSON.stringify(config), (path) => {
    assert.deepEqual(loadSuiteConfig(path), loadOAuthSuiteConfig(path));
  });
});

test("loadOAuthSuiteConfig throws on missing file", () => {
  assert.throws(
    () => loadOAuthSuiteConfig("/nonexistent/path/config.json"),
    (error) => error instanceof CliError && error.message.includes("Cannot read"),
  );
});

test("loadOAuthSuiteConfig throws on invalid JSON", () => {
  withTempFile("not json {{{", (path) => {
    assert.throws(
      () => loadOAuthSuiteConfig(path),
      (error) => error instanceof CliError && error.message.includes("not valid JSON"),
    );
  });
});

test("loadOAuthSuiteConfig throws on missing serverUrl", () => {
  withTempFile(JSON.stringify({ flows: [{ protocolVersion: "2025-11-25", registrationStrategy: "dcr" }] }), (path) => {
    assert.throws(
      () => loadOAuthSuiteConfig(path),
      (error) => error instanceof CliError && error.message.includes("serverUrl"),
    );
  });
});

test("loadOAuthSuiteConfig throws on empty flows", () => {
  withTempFile(JSON.stringify({ serverUrl: "https://example.com/mcp", flows: [] }), (path) => {
    assert.throws(
      () => loadOAuthSuiteConfig(path),
      (error) => error instanceof CliError && error.message.includes("non-empty"),
    );
  });
});

test("loadOAuthSuiteConfig throws on invalid protocol version", () => {
  const config = {
    serverUrl: "https://example.com/mcp",
    flows: [{ protocolVersion: "invalid", registrationStrategy: "dcr" }],
  };

  withTempFile(JSON.stringify(config), (path) => {
    assert.throws(
      () => loadOAuthSuiteConfig(path),
      (error) =>
        error instanceof CliError && error.message.includes("protocolVersion"),
    );
  });
});

test("loadOAuthSuiteConfig throws on invalid registration strategy", () => {
  const config = {
    serverUrl: "https://example.com/mcp",
    flows: [{ protocolVersion: "2025-11-25", registrationStrategy: "invalid" }],
  };

  withTempFile(JSON.stringify(config), (path) => {
    assert.throws(
      () => loadOAuthSuiteConfig(path),
      (error) =>
        error instanceof CliError && error.message.includes("registrationStrategy"),
    );
  });
});

test("loadOAuthSuiteConfig accepts flows that inherit from defaults", () => {
  const config = {
    serverUrl: "https://example.com/mcp",
    defaults: {
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
    },
    flows: [{ label: "inherits defaults" }],
  };

  withTempFile(JSON.stringify(config), (path) => {
    const result = loadOAuthSuiteConfig(path);
    assert.equal(result.flows[0].label, "inherits defaults");
  });
});

test("loadOAuthSuiteConfig validates auth mode enum", () => {
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
      () => loadOAuthSuiteConfig(path),
      (error) =>
        error instanceof CliError && error.message.includes("auth.mode"),
    );
  });
});

test("loadProtocolSuiteConfig loads a valid config file", () => {
  const config = {
    name: "Protocol Suite",
    serverUrl: "https://mcp.example.com/mcp",
    defaults: {
      categories: ["core"],
    },
    runs: [
      {
        label: "ping",
        checkIds: ["ping"],
      },
    ],
  };

  withTempFile(JSON.stringify(config), (path) => {
    const result = loadProtocolSuiteConfig(path);
    assert.equal(result.serverUrl, "https://mcp.example.com/mcp");
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].label, "ping");
    assert.deepEqual(result.defaults?.categories, ["core"]);
  });
});

test("loadProtocolSuiteConfig throws on invalid protocol check ids", () => {
  const config = {
    serverUrl: "https://mcp.example.com/mcp",
    runs: [{ checkIds: ["ping", "not-a-check"] }],
  };

  withTempFile(JSON.stringify(config), (path) => {
    assert.throws(
      () => loadProtocolSuiteConfig(path),
      (error) =>
        error instanceof CliError && error.message.includes("runs[0].checkIds[1]"),
    );
  });
});

test("loadAppsSuiteConfig loads an HTTP target config file", () => {
  const config = {
    name: "Apps Suite",
    target: {
      url: "https://mcp.example.com/mcp",
      timeout: 15000,
    },
    defaults: {
      checkIds: ["ui-tools-present"],
    },
    runs: [
      {
        label: "tools",
      },
    ],
  };

  withTempFile(JSON.stringify(config), (path) => {
    const result = loadAppsSuiteConfig(path);
    assert.equal(result.target.url, "https://mcp.example.com/mcp");
    assert.equal(result.runs[0].label, "tools");
    assert.deepEqual(result.defaults?.checkIds, ["ui-tools-present"]);
  });
});

test("loadAppsSuiteConfig loads a stdio target config file", () => {
  const config = {
    target: {
      command: "node",
      args: ["./mock-server.mjs"],
      env: {
        NODE_ENV: "test",
      },
      cwd: "/tmp/example",
    },
    runs: [
      {
        checkIds: ["ui-resource-meta-valid"],
      },
    ],
  };

  withTempFile(JSON.stringify(config), (path) => {
    const result = loadAppsSuiteConfig(path);
    assert.equal(result.target.command, "node");
    assert.deepEqual(result.target.args, ["./mock-server.mjs"]);
    assert.deepEqual(result.target.env, { NODE_ENV: "test" });
    assert.equal(result.target.cwd, "/tmp/example");
  });
});

test("loadAppsSuiteConfig rejects missing target", () => {
  withTempFile(JSON.stringify({ runs: [{ checkIds: ["ui-tools-present"] }] }), (path) => {
    assert.throws(
      () => loadAppsSuiteConfig(path),
      (error) =>
        error instanceof CliError && error.message.includes('"target" object'),
    );
  });
});

test("loadAppsSuiteConfig rejects ambiguous targets", () => {
  const config = {
    target: {
      url: "https://mcp.example.com/mcp",
      command: "node",
    },
    runs: [{ checkIds: ["ui-tools-present"] }],
  };

  withTempFile(JSON.stringify(config), (path) => {
    assert.throws(
      () => loadAppsSuiteConfig(path),
      (error) =>
        error instanceof CliError &&
        error.message.includes('exactly one of "url" or "command"'),
    );
  });
});

test("loadAppsSuiteConfig rejects invalid apps check ids", () => {
  const config = {
    target: {
      command: "node",
    },
    runs: [{ checkIds: ["ui-tools-present", "bad-check"] }],
  };

  withTempFile(JSON.stringify(config), (path) => {
    assert.throws(
      () => loadAppsSuiteConfig(path),
      (error) =>
        error instanceof CliError && error.message.includes("runs[0].checkIds[1]"),
    );
  });
});
