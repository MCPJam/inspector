/**
 * Where a trace destination's header values come from, and the three-way
 * distinction the API depends on.
 *
 * `resolveHeaders` has to answer three different questions, and two of them
 * look alike from a distance:
 *
 *   - `undefined` — no header flag. The API leaves the stored set alone.
 *   - `{}` — `--clear-headers`. The API replaces the set with nothing.
 *   - a record — the new set, replacing the stored one.
 *
 * Collapsing the first two is what makes a destination keep sending the old
 * vendor's credentials to a new endpoint, so they are pinned apart here.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveAttributes,
  resolveHeaders,
  resolveSourceTypes,
} from "../src/commands/trace-destinations.js";

async function fileWith(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-header-"));
  const file = path.join(dir, "value");
  await writeFile(file, contents, "utf8");
  return file;
}

test("no header flag means leave the stored set alone", () => {
  assert.equal(resolveHeaders({}), undefined);
});

test("--clear-headers means replace the set with nothing", () => {
  // NOT undefined. The whole point is that this reaches the API as an empty
  // set, which is what removes the stored credentials.
  assert.deepEqual(resolveHeaders({ clearHeaders: true }), {});
});

test("--clear-headers refuses to be combined with a header", () => {
  assert.throws(
    () =>
      resolveHeaders({
        clearHeaders: true,
        header: ["Authorization: Bearer tok"],
      }),
    /cannot be combined/
  );
});

test("an argument with no separator says so; an empty name says THAT", () => {
  // Two different mistakes, and folding them into one check told someone who
  // wrote ": value" that their argument had no separator — the one thing it
  // did have — while making the empty-name message unreachable.
  assert.throws(
    () => resolveHeaders({ header: ["Authorization Bearer tok"] }),
    /had no ":"/
  );
  assert.throws(
    () => resolveHeaders({ header: [": Bearer tok"] }),
    /empty name before/
  );
});

test("a malformed header does not echo what was in the name position", () => {
  // `--header` splits on the FIRST colon, so a mistyped argument can put the
  // credential in the name position. The message goes to stderr and into CI
  // logs, so it states the rule and quotes nothing.
  let message = "";
  try {
    resolveHeaders({ header: ["Bearer sk-live-do-not-echo=x: v"] });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /not an HTTP token/);
  assert.doesNotMatch(message, /sk-live-do-not-echo/);
});

test("--header splits on the first colon only", () => {
  assert.deepEqual(
    resolveHeaders({ header: ["Authorization: Bearer a:b:c"] }),
    {
      Authorization: "Bearer a:b:c",
    }
  );
});

test("--header-env reads the variable, and refuses an unset one", () => {
  process.env.MCPJAM_TEST_HEADER = "Bearer from-env";
  try {
    assert.deepEqual(
      resolveHeaders({ headerEnv: ["Authorization=MCPJAM_TEST_HEADER"] }),
      { Authorization: "Bearer from-env" }
    );
  } finally {
    delete process.env.MCPJAM_TEST_HEADER;
  }
  assert.throws(
    () => resolveHeaders({ headerEnv: ["Authorization=MCPJAM_UNSET_HEADER"] }),
    /is not set/
  );
});

test("--header-file drops the one trailing newline a shell adds", async () => {
  // Unlike a secret VALUE, which keeps it: a header cannot span lines at all,
  // so a trailing newline is never part of the credential here.
  const file = await fileWith("Bearer from-file\n");
  assert.deepEqual(resolveHeaders({ headerFile: [`Authorization=${file}`] }), {
    Authorization: "Bearer from-file",
  });
});

test("a header value containing a newline is refused, not forwarded", async () => {
  const file = await fileWith("Bearer one\nX-Injected: two\n");
  await assert.rejects(
    async () => resolveHeaders({ headerFile: [`Authorization=${file}`] }),
    /cannot span lines/
  );
});

test("the same header twice is a usage error, case-insensitively", () => {
  // The env var is set so the DUPLICATE check is what fires — an unset one
  // would throw first and the test would pass for the wrong reason.
  process.env.MCPJAM_TEST_DUP_HEADER = "b";
  try {
    assert.throws(
      () =>
        resolveHeaders({
          header: ["Authorization: a"],
          headerEnv: ["authorization=MCPJAM_TEST_DUP_HEADER"],
        }),
      /was given twice/
    );
  } finally {
    delete process.env.MCPJAM_TEST_DUP_HEADER;
  }
});

test("a header named __proto__ becomes a key, not a prototype", () => {
  // `__proto__` passes the HTTP-token rule, and assigning it on an object
  // literal would silently set the prototype instead of adding a header.
  const headers = resolveHeaders({ header: ["__proto__: surprise"] });
  assert.deepEqual(Object.keys(headers ?? {}), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(headers), Object.prototype);
});

test("an attribute named toString is not mistaken for a duplicate", () => {
  // `key in out` reports every inherited member as present, so this was
  // rejected as already given before the own-property check.
  assert.deepEqual(resolveAttributes(["toString=fine"]), { toString: "fine" });
  assert.throws(() => resolveAttributes(["a=1", "a=2"]), /was given twice/);
});

test("--source rejects an unknown value and de-duplicates the rest", () => {
  assert.deepEqual(resolveSourceTypes(["eval", "eval", "swarm"]), [
    "eval",
    "swarm",
  ]);
  assert.throws(() => resolveSourceTypes(["evals"]), /--source expects/);
});

test("a malformed --header never quotes the argument back", () => {
  // The right-hand side IS the credential, and a forgotten colon is the
  // likeliest typo on this flag. Echoing the argument put the token in stderr,
  // in CI logs and in scrollback — the one thing this command promises it
  // cannot do.
  const secret = "sk-live-DO-NOT-PRINT-ME";
  assert.throws(
    () => resolveHeaders({ header: [`Authorization Bearer ${secret}`] }),
    (error: Error) => {
      assert.match(error.message, /--header expects/);
      assert.doesNotMatch(error.message, /DO-NOT-PRINT-ME/);
      return true;
    }
  );
});

test("a header NAME carrying a CRLF is refused locally", () => {
  // Header-name injection should not travel the wire to be refused as a
  // malformed record key; the API enforces the same HTTP-token rule.
  assert.throws(
    () => resolveHeaders({ header: ["X-Evil\r\nX-Injected: yes: value"] }),
    /is not an HTTP token/
  );
  assert.throws(
    () => resolveHeaders({ header: ["Content Type: text/plain"] }),
    /is not an HTTP token/
  );
});

test("a header VALUE carrying a null byte is refused", () => {
  // CR and LF were already checked; NUL terminates a header on some stacks
  // and cannot appear in a legitimate credential either.
  assert.throws(
    () => resolveHeaders({ header: ["Authorization: tok\u0000injected"] }),
    /null byte/
  );
});
