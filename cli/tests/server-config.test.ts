import assert from "node:assert/strict";
import test from "node:test";
import {
  parseJsonRecord,
  parseServerConfig,
} from "../src/lib/server-config";
import { CliError } from "../src/lib/output";

test("parseServerConfig builds an HTTP config with access token and headers", () => {
  const config = parseServerConfig({
    url: "https://example.com/mcp",
    accessToken: "secret-token",
    header: ["X-Test: yes", "X-Trace: abc123"],
    timeout: 1234,
  });

  assert.equal("url" in config, true);
  assert.equal(config.url, "https://example.com/mcp");
  assert.equal(config.accessToken, "secret-token");
  assert.deepEqual(config.requestInit?.headers, {
    "X-Test": "yes",
    "X-Trace": "abc123",
  });
  assert.equal(config.timeout, 1234);
});

test("parseServerConfig builds a stdio config with args and env", () => {
  const config = parseServerConfig({
    command: "node",
    commandArgs: ["server.js", "--flag"],
    env: ["FOO=bar", "BAZ=qux"],
    timeout: 5000,
  });

  assert.equal("command" in config, true);
  assert.equal(config.command, "node");
  assert.deepEqual(config.args, ["server.js", "--flag"]);
  assert.deepEqual(config.env, {
    FOO: "bar",
    BAZ: "qux",
  });
  assert.equal(config.stderr, "ignore");
  assert.equal(config.timeout, 5000);
});

test("parseServerConfig preserves commas inside stdio args and env values", () => {
  const config = parseServerConfig({
    command: "node",
    commandArgs: ['{"a":1,"b":2}', "--list=one,two"],
    env: [
      "NO_PROXY=127.0.0.1,localhost",
      'JSON_PAYLOAD={"a":1,"b":2}',
    ],
  });

  assert.equal("command" in config, true);
  assert.deepEqual(config.args, ['{"a":1,"b":2}', "--list=one,two"]);
  assert.deepEqual(config.env, {
    NO_PROXY: "127.0.0.1,localhost",
    JSON_PAYLOAD: '{"a":1,"b":2}',
  });
});

test("parseServerConfig rejects missing and mixed targets", () => {
  assert.throws(
    () =>
      parseServerConfig({
        timeout: 1000,
      }),
    (error) =>
      error instanceof CliError &&
      error.exitCode === 2 &&
      error.message.includes("Specify exactly one target"),
  );

  assert.throws(
    () =>
      parseServerConfig({
        url: "https://example.com/mcp",
        command: "node",
      }),
    (error) =>
      error instanceof CliError &&
      error.exitCode === 2 &&
      error.message.includes("Specify exactly one target"),
  );

  assert.throws(
    () =>
      parseServerConfig({
        command: "node",
        header: ["X-Test: yes"],
      }),
    (error) =>
      error instanceof CliError &&
      error.exitCode === 2 &&
      error.message.includes("--access-token and --header can only be used"),
  );
});

test("parseJsonRecord rejects non-object JSON", () => {
  assert.equal(parseJsonRecord('{"message":"hello"}', "Tool parameters")?.message, "hello");

  assert.throws(
    () => parseJsonRecord('["hello"]', "Tool parameters"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Tool parameters must be a JSON object"),
  );
});
