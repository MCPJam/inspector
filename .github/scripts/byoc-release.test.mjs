import { test } from "node:test";
import assert from "node:assert/strict";
import dispatch from "./byoc-release.cjs";

const sha = "a".repeat(40);
async function run({
  privateRepo = true,
  tag = "v3.19.0",
  revision = sha,
  fail = false,
} = {}) {
  process.env.RELEASE_TAG = tag;
  process.env.BACKEND_REPO = "MCPJam/mcpjam-backend";
  const calls = [];
  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { private: privateRepo } }),
        createDispatchEvent: async (value) => {
          if (fail) throw new Error("dispatch denied");
          calls.push(value);
        },
      },
    },
  };
  const core = {
    info: () => {},
    summary: { addRaw: () => ({ write: async () => {} }) },
  };
  await dispatch({ github, context: { sha: revision }, core });
  return calls;
}

test("dispatches the exact released revision to private bundle assembly", async () => {
  assert.deepEqual(await run(), [
    {
      owner: "MCPJam",
      repo: "mcpjam-backend",
      event_type: "inspector_byoc_release",
      client_payload: { sha, release_tag: "v3.19.0" },
    },
  ]);
});
test("refuses public source publication and invalid revisions", async () => {
  await assert.rejects(run({ privateRepo: false }), /private/);
  await assert.rejects(run({ revision: "main" }), /full SHA/);
  await assert.rejects(run({ tag: "latest" }), /versioned/);
});
test("reports dispatch failures rather than claiming a candidate exists", async () => {
  await assert.rejects(run({ fail: true }), /dispatch denied/);
});

test("release completion waits for the BYOC dispatch result", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  const workflow = parse(
    readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8"),
  );
  assert.ok(workflow.jobs["announce-finish"].needs.includes("byoc-candidate"));
  assert.deepEqual(workflow.jobs["byoc-candidate"].needs, [
    "preflight",
    "finalize",
  ]);
});


test("requests candidates for both new releases and desktop-only completion", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const { parse } = await import("yaml");
  const { planRelease } = await import("./release-plan.mjs");
  const workflow = parse(readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8"));
  const evaluate = (outputs, result = "success") => runInNewContext(workflow.jobs["byoc-candidate"].if, {
    always: () => true,
    needs: { preflight: { result: "success", outputs }, finalize: { result } },
  });
  const base = { inspectorVersion: "3.19.0", inspectorReleaseExists: false };
  const fresh = planRelease({ ...base, unpublished: [{ name: "@mcpjam/inspector", newVersion: "3.19.0" }] });
  const resumed = planRelease({ ...base, unpublished: [] });
  const packages = planRelease({ ...base, inspectorReleaseExists: true, unpublished: [{ name: "@mcpjam/sdk", newVersion: "10.3.0" }] });
  assert.equal(evaluate(fresh), true);
  assert.equal(evaluate(resumed), true);
  assert.equal(evaluate(packages), false);
  assert.equal(evaluate(fresh, "failure"), false);
});
