import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseVersionTag,
  highestVersionTag,
  nextVersionTag,
} from "./release-tags.mjs";

test("starts the family at 1.0.0 and bumps the patch after that", () => {
  assert.equal(nextVersionTag([]), "evals-v1.0.0");
  assert.equal(nextVersionTag(["evals-v1.0.0"]), "evals-v1.0.1");
});

test("orders versions numerically, so a published tag is never reissued", () => {
  // Lexicographically "evals-v1.0.10" < "evals-v1.0.9", which would hand back
  // a tag that already exists and fail the push.
  assert.equal(
    nextVersionTag(["evals-v1.0.9", "evals-v1.0.10"]),
    "evals-v1.0.11",
  );
  assert.equal(nextVersionTag(["evals-v1.0.5", "evals-v1.1.0"]), "evals-v1.1.1");
});

test("reads only this family's version tags", () => {
  assert.equal(
    nextVersionTag([
      "v3.5.4",
      "evals-v1",
      "evals-v2.0.0",
      "evals-v1.0.0-rc1",
      "evals-v1.x.y",
      "evals-v1.0",
      "",
    ]),
    "evals-v1.0.0",
  );
  assert.equal(highestVersionTag(["evals-v1", "v3.5.4"]), null);
});

test("tolerates the whitespace of `git tag -l` output", () => {
  assert.equal(
    nextVersionTag("evals-v1.0.0\nevals-v1.0.1\n".split("\n")),
    "evals-v1.0.2",
  );
});

test("keeps the tag a commit already carries, so a re-run finishes the job", () => {
  assert.equal(
    chooseVersionTag(
      ["evals-v1.0.0", "evals-v1.0.1"],
      ["evals-v1.0.1", "evals-v1"],
    ),
    "evals-v1.0.1",
  );
});

test("publishes a new tag for a commit that carries none", () => {
  assert.equal(chooseVersionTag(["evals-v1.0.0"], []), "evals-v1.0.1");
  assert.equal(chooseVersionTag([], ["evals-v1"]), "evals-v1.0.0");
});

test("always moves forward", () => {
  let tags = [];
  for (let release = 0; release < 12; release += 1) {
    const next = nextVersionTag(tags);
    assert.equal(highestVersionTag([...tags, next]), next);
    tags = [...tags, next];
  }
  assert.equal(tags.at(-1), "evals-v1.0.11");
});
