import { test } from "node:test";
import assert from "node:assert/strict";
import { unpublishedVersions } from "./unpublished-versions.mjs";

const published = (version) => ({ status: 0, stdout: JSON.stringify(version) });
const missing = {
  status: 1,
  stdout: JSON.stringify({ error: { code: "E404" } }),
};
const tree = (packages) => (path) => {
  if (path === "package.json")
    return { workspaces: Object.keys(packages) };
  return packages[path.replace(/\/package\.json$/, "")];
};

test("lists public packages whose version the registry does not have", () => {
  const readJson = tree({
    sdk: { name: "@mcpjam/sdk", version: "8.16.1" },
    cli: { name: "@mcpjam/cli", version: "5.11.3" },
  });
  const run = ([, spec]) =>
    spec === "@mcpjam/sdk@8.16.1" ? missing : published("5.11.3");
  assert.deepEqual(unpublishedVersions(readJson, run), [
    { name: "@mcpjam/sdk", newVersion: "8.16.1" },
  ]);
});

test("never asks the registry about private workspaces", () => {
  const readJson = tree({
    soundcheck: { name: "@mcpjam/soundcheck", version: "0.0.0", private: true },
  });
  const run = () => assert.fail("private package reached the registry");
  assert.deepEqual(unpublishedVersions(readJson, run), []);
});

test("fails closed on any registry error other than E404", () => {
  const readJson = tree({ sdk: { name: "@mcpjam/sdk", version: "8.16.1" } });
  for (const result of [
    { status: 1, stdout: JSON.stringify({ error: { code: "E500" } }) },
    { status: 1, stdout: "npm error network" },
    published("8.16.0"),
  ]) {
    assert.throws(() => unpublishedVersions(readJson, () => result));
  }
});

test("refuses glob workspaces instead of skipping them", () => {
  const readJson = () => ({ workspaces: ["packages/*"] });
  assert.throws(() => unpublishedVersions(readJson, () => missing), /glob/);
});
