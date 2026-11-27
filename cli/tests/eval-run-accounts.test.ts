import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformEvalRun } from "@mcpjam/sdk/platform";
import {
  runAccountLines,
  runAccountServerNames,
  writeRunAccounts,
} from "../src/lib/eval-run-accounts.js";

type Accounts = NonNullable<PlatformEvalRun["accounts"]>;

const NAMES = new Map([["srv-linear", "Linear"]]);

test("one line per server, each account once across a fan-out", () => {
  const first: Accounts = [
    { serverId: "srv-linear", name: "bot-a", kind: "personal" },
    { serverId: "srv-linear", name: "bot-b", kind: "personal" },
  ];
  const second: Accounts = [
    { serverId: "srv-linear", name: "bot-a", kind: "personal" },
  ];
  assert.deepEqual(
    runAccountLines([{ accounts: first }, { accounts: second }], NAMES),
    ["Accounts on Linear: bot-a (personal), bot-b (personal)"]
  );
});

test("names whose token it was: the email, else a different identity name", () => {
  const accounts: Accounts = [
    {
      serverId: "srv-linear",
      name: "bot-a",
      kind: "project",
      identity: { source: "token", name: "QA Bot" },
    },
    {
      serverId: "srv-xaa",
      name: "alice",
      kind: "xaa",
      identity: { source: "token", name: "alice" },
    },
  ];
  assert.deepEqual(runAccountLines([{ accounts }], NAMES), [
    "Account on Linear: bot-a (project, QA Bot)",
    "Account on srv-xaa: alice (XAA)",
  ]);
});

test("strips terminal control sequences from server-supplied names", () => {
  const accounts: Accounts = [
    { serverId: "srv-linear", name: "bot\u001b[2Ja", kind: "personal" },
  ];
  assert.deepEqual(runAccountLines([{ accounts }], NAMES), [
    "Account on Linear: bot [2Ja (personal)",
  ]);
});

test("prints nothing for a run that recorded no accounts, or in JSON", () => {
  const written: string[] = [];
  const out = { write: (chunk: string) => written.push(chunk) > 0 };
  writeRunAccounts("human", [{}, { accounts: [] }], NAMES, out);
  writeRunAccounts(
    "json",
    [{ accounts: [{ serverId: "srv-linear", name: "a", kind: "personal" }] }],
    NAMES,
    out
  );
  assert.deepEqual(written, []);
});

test("reads server names only when a person reads accounts, and survives a failed read", async () => {
  let reads = 0;
  const client = {
    listProjectServers: async () => {
      reads += 1;
      throw new Error("unavailable");
    },
  };
  const signal = new AbortController().signal;
  const runs = [
    { accounts: [{ serverId: "srv-linear", name: "a", kind: "personal" }] },
  ] satisfies Array<Pick<PlatformEvalRun, "accounts">>;
  assert.equal(
    (await runAccountServerNames(client, signal, "p", runs, "json")).size,
    0
  );
  assert.equal(
    (await runAccountServerNames(client, signal, "p", [{}], "human")).size,
    0
  );
  assert.equal(reads, 0);
  assert.equal(
    (await runAccountServerNames(client, signal, "p", runs, "human")).size,
    0
  );
  assert.equal(reads, 1);
});
