/**
 * Where a secret's bytes come from, and what is allowed to change them.
 *
 * The rule this pins: a FILE is read verbatim, and only STDIN loses one
 * trailing newline. Stripping unconditionally stored a different secret than
 * the file held — a PEM block's final LF is part of the credential — and the
 * failure surfaces much later as "the API key is wrong" with nothing to look
 * at. The REST schema and `--value-env` both preserve whitespace; a file has
 * to agree with them.
 *
 * Stdin keeps the strip because there the newline is almost always the
 * shell's, not the credential's: `echo tok | mcpjam …` is the dominant idiom.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveSecretValue } from "../src/commands/secrets.js";

const PEM = "-----BEGIN KEY-----\nabc\n-----END KEY-----\n";

async function fileWith(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-secret-"));
  const file = path.join(dir, "value");
  await writeFile(file, contents, "utf8");
  return file;
}

test("--value-file keeps a PEM block's trailing newline", async () => {
  const file = await fileWith(PEM);
  const value = resolveSecretValue({ valueFile: file }, { required: true });
  assert.equal(value, PEM);
});

test("--value-file keeps a lone trailing newline verbatim", async () => {
  const file = await fileWith("sk_live_x\n");
  const value = resolveSecretValue({ valueFile: file }, { required: true });
  assert.equal(value, "sk_live_x\n");
});

test("--value-file returns a newline-free value unchanged", async () => {
  const file = await fileWith("sk_live_x");
  const value = resolveSecretValue({ valueFile: file }, { required: true });
  assert.equal(value, "sk_live_x");
});

test("--value-env preserves whitespace, as it always did", () => {
  process.env.MCPJAM_TEST_SECRET = PEM;
  try {
    const value = resolveSecretValue(
      { valueEnv: "MCPJAM_TEST_SECRET" },
      { required: true }
    );
    assert.equal(value, PEM);
  } finally {
    delete process.env.MCPJAM_TEST_SECRET;
  }
});
