import assert from "node:assert/strict";
import test from "node:test";
import { OPERATION_KEY_META as SDK_OPERATION_KEY_META } from "@mcpjam/sdk/mocks";
import { OPERATION_KEY_META, operationKeyMetadata } from "../src/lib/operation-key.js";
import { CliError } from "../src/lib/output.js";

test("the request _meta key is the one a mock reads", () => {
  assert.equal(OPERATION_KEY_META, SDK_OPERATION_KEY_META);
});

test("a key becomes the call's metadata, and no key adds none", () => {
  assert.deepEqual(operationKeyMetadata("k-1"), { [SDK_OPERATION_KEY_META]: "k-1" });
  assert.equal(operationKeyMetadata(undefined), undefined);
});

test("an empty key, or one over 256 characters, is a usage error that says what to do", () => {
  for (const bad of ["", "x".repeat(257)]) {
    assert.throws(
      () => operationKeyMetadata(bad),
      (error: unknown) => error instanceof CliError && error.code === "USAGE_ERROR" && /shorter key/.test(error.message),
    );
  }
  assert.ok(operationKeyMetadata("x".repeat(256)));
});
