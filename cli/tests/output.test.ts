import assert from "node:assert/strict";
import test from "node:test";
import {
  CliError,
  detectOutputFormatFromArgv,
  parseOutputFormat,
  resolveOutputFormat,
  routeConsoleToStderr,
} from "../src/lib/output.js";

test("resolveOutputFormat defaults to human on TTY and json otherwise", () => {
  assert.equal(resolveOutputFormat(undefined, true), "human");
  assert.equal(resolveOutputFormat(undefined, false), "json");
  assert.equal(resolveOutputFormat("json", true), "json");
  assert.equal(resolveOutputFormat("human", false), "human");
});

test("detectOutputFormatFromArgv respects explicit flags and TTY defaults", () => {
  assert.equal(
    detectOutputFormatFromArgv(["node", "cli"], true),
    "human",
  );
  assert.equal(
    detectOutputFormatFromArgv(["node", "cli"], false),
    "json",
  );
  assert.equal(
    detectOutputFormatFromArgv(["node", "cli", "--format", "human"], false),
    "human",
  );
  assert.equal(
    detectOutputFormatFromArgv(["node", "cli", "--format=json"], true),
    "json",
  );
});

test("parseOutputFormat keeps reporter formats out of --format", () => {
  assert.throws(
    () => parseOutputFormat("junit-xml"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Use --reporter junit-xml"),
  );
  assert.throws(
    () => parseOutputFormat("json-summary"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Use --reporter json-summary"),
  );
});

test("routeConsoleToStderr keeps console.log/info/debug off stdout until restored", () => {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
  };
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const restore = routeConsoleToStderr();
    console.log("from log");
    console.info("from info");
    console.debug("from debug %s", "formatted");
    restore();

    assert.equal(stdout, "");
    assert.equal(stderr, "from log\nfrom info\nfrom debug formatted\n");
    assert.equal(console.log, originalConsole.log);
    assert.equal(console.info, originalConsole.info);
    assert.equal(console.debug, originalConsole.debug);
  } finally {
    Object.assign(console, originalConsole);
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});
