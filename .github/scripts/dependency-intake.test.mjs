import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addedDependencies,
  approvedAtHead,
  hasIntakeBlock,
} from "./dependency-intake.mjs";

test("lists names new to every dependency field, not version bumps or moves", () => {
  const base = {
    dependencies: { hono: "^4.0.0" },
    devDependencies: { vitest: "^2.0.0" },
  };
  const head = {
    dependencies: { hono: "^4.1.0", vitest: "^2.0.0", zod: "^3.0.0" },
    peerDependencies: { react: "^19.0.0" },
    optionalDependencies: { fsevents: "^2.0.0" },
  };
  assert.deepEqual(addedDependencies(base, head), ["fsevents", "react", "zod"]);
  assert.deepEqual(
    addedDependencies(base, { dependencies: { hono: "^5.0.0" } }),
    []
  );
});

test("finds the intake block but not one inside an HTML comment", () => {
  assert.equal(
    hasIntakeBlock("## Notes\n**Dependency intake:**\n- need: yes"),
    true
  );
  assert.equal(hasIntakeBlock("<!-- Dependency intake: fill me -->"), false);
  assert.equal(hasIntakeBlock("<!--\nDependency intake: hidden"), false);
  assert.equal(
    hasIntakeBlock("<!<!---->--\nDependency intake: hidden"),
    false
  );
  assert.equal(hasIntakeBlock(null), false);
});

test("a comment marker inside fenced code does not hide the intake block", () => {
  assert.equal(
    hasIntakeBlock("```html\n<!-- example\n```\nDependency intake:\n- need: yes"),
    true
  );
  assert.equal(
    hasIntakeBlock("~~~~\n<!--\n~~~~~\n**Dependency intake:**"),
    true
  );
  assert.equal(
    hasIntakeBlock("<!--\n```\n-->\nDependency intake: shown"),
    true
  );
  assert.equal(
    hasIntakeBlock("<!--\n```\nDependency intake: hidden\n```"),
    false
  );
});

const review = (login, state, commit = "head", extra = {}) => ({
  user: { login, type: "User" },
  state,
  commit_id: commit,
  author_association: "MEMBER",
  ...extra,
});

test("needs a non-author approval of the latest commit", () => {
  assert.equal(
    approvedAtHead([review("bob", "APPROVED")], "alice", "head"),
    true
  );
  assert.equal(
    approvedAtHead([review("alice", "APPROVED")], "alice", "head"),
    false
  );
  assert.equal(
    approvedAtHead([review("bob", "APPROVED", "old")], "alice", "head"),
    false
  );
  const bot = review("ci[bot]", "APPROVED", "head", {
    user: { login: "ci[bot]", type: "Bot" },
  });
  assert.equal(approvedAtHead([bot], "alice", "head"), false);
  const outsider = review("eve", "APPROVED", "head", {
    author_association: "CONTRIBUTOR",
  });
  assert.equal(approvedAtHead([outsider], "alice", "head"), false);
});

test("a later request for changes replaces an approval; a comment does not", () => {
  const approve = review("bob", "APPROVED");
  assert.equal(
    approvedAtHead(
      [approve, review("bob", "CHANGES_REQUESTED")],
      "alice",
      "head"
    ),
    false
  );
  assert.equal(
    approvedAtHead([approve, review("bob", "COMMENTED")], "alice", "head"),
    true
  );
});
