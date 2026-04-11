import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ALL_PROTOCOL_VERSIONS,
  buildSuiteConfigForServer,
  loadMatrixConfig,
  normalizeMatrixConfig,
} from "../scripts/run-oauth-matrix.mjs";

test("normalizeMatrixConfig supports a bare array", () => {
  const config = normalizeMatrixConfig([
    {
      url: "https://mcp.linear.app/mcp",
    },
  ]);

  assert.equal(config.format, "human");
  assert.equal(config.defaults.authMode, "interactive");
  assert.deepEqual(config.defaults.protocolVersions, ALL_PROTOCOL_VERSIONS);
  assert.deepEqual(config.defaults.registrationStrategies, ["dcr"]);
  assert.equal(config.servers.length, 1);
});

test("loadMatrixConfig supports object config with top-level format and default headers", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oauth-matrix-test-"));
  const configPath = path.join(dir, "matrix.json");

  writeFileSync(
    configPath,
    `${JSON.stringify({
      format: "json",
      defaults: {
        authMode: "interactive",
        protocolVersions: ["2025-06-18", "2025-11-25"],
        registrationStrategies: ["dcr"],
        headers: {
          "X-Test": "1",
        },
      },
      servers: [
        {
          url: "https://example.com/mcp",
        },
      ],
    })}\n`,
    "utf8",
  );

  const config = loadMatrixConfig(configPath);

  assert.equal(config.format, "json");
  assert.deepEqual(config.defaults.protocolVersions, ["2025-06-18", "2025-11-25"]);
  assert.deepEqual(config.defaults.registrationStrategies, ["dcr"]);
  assert.deepEqual(config.defaults.headers, {
    "X-Test": "1",
  });
});

test("buildSuiteConfigForServer expands valid protocol/registration combinations", () => {
  const suite = buildSuiteConfigForServer(
    {
      label: "Linear",
      url: "https://mcp.linear.app/mcp",
      registrationStrategies: ["dcr", "cimd"],
    },
    {
      authMode: "interactive",
      protocolVersions: ALL_PROTOCOL_VERSIONS,
    },
  );

  assert.equal(suite.serverUrl, "https://mcp.linear.app/mcp");
  assert.deepEqual(
    suite.flows.map((flow) => flow.label),
    [
      "2025-03-26/dcr/interactive",
      "2025-06-18/dcr/interactive",
      "2025-11-25/dcr/interactive",
      "2025-11-25/cimd/interactive",
    ],
  );
});

test("buildSuiteConfigForServer merges default and per-server headers", () => {
  const suite = buildSuiteConfigForServer(
    {
      label: "Linear",
      url: "https://mcp.linear.app/mcp",
      headers: ["X-Server: 2"],
    },
    {
      authMode: "interactive",
      protocolVersions: ["2025-06-18"],
      registrationStrategies: ["dcr"],
      headers: {
        "X-Default": "1",
      },
    },
  );

  assert.deepEqual(suite.defaults?.customHeaders, {
    "X-Default": "1",
    "X-Server": "2",
  });
});

test("buildSuiteConfigForServer requires clientId for preregistered flows", () => {
  assert.throws(
    () =>
      buildSuiteConfigForServer(
        {
          label: "Needs prereg",
          url: "https://example.com/mcp",
          registrationStrategies: ["preregistered"],
        },
        {
          authMode: "interactive",
          protocolVersions: ["2025-06-18"],
        },
      ),
    /missing clientId/i,
  );
});

test("buildSuiteConfigForServer rejects non-interactive auth for the matrix runner", () => {
  assert.throws(
    () =>
      buildSuiteConfigForServer(
        {
          label: "Bad auth",
          url: "https://example.com/mcp",
          registrationStrategies: ["dcr"],
          authMode: "headless",
        },
        {
          authMode: "interactive",
          protocolVersions: ["2025-06-18"],
        },
      ),
    /interactive auth only/i,
  );
});
