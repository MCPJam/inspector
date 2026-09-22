/**
 * Packaging E2E: install the TARBALL into a clean project and prove the exit
 * behaviour a consumer's CI depends on.
 *
 * Everything else in this package is tested against `src/`, inside a workspace
 * where `@mcpjam/sdk` resolves by symlink and every devDependency is already
 * present. None of that is true for someone who runs `npm i -D @mcpjam/vitest`.
 * The failures this catches are exactly the ones unit tests cannot see: a file
 * missing from `files`, an import that only resolved because of the workspace
 * layout, a peer dependency that was really a hard one, or a `dist` that was
 * never rebuilt.
 *
 * Three child processes, because the contract is about EXIT CODES and only a
 * real `vitest run` produces one:
 *
 *   1. a passing suite            → exit 0
 *   2. one failing case           → non-zero, and the case title is in the output
 *   3. a passing suite, failing gate → non-zero, and the gate table is in the output
 *
 * Case 3 is the one worth the setup cost. A run where every case passes but
 * the policy is breached must still fail the build; if the gate silently
 * degraded to a no-op, cases 1 and 2 would both still pass and nothing else in
 * the repo would notice.
 *
 * Wired into root `test:ci:packaging` — the script the `Packaging` job in
 * test.yml actually invokes — and into `test:ordered`. `test:ordered` alone
 * would have been dead weight: no workflow references it, so a gate wired only
 * there runs at authoring time and never again.
 *
 * `prepack` builds before packing. `npm pack` does NOT run `prepublishOnly`
 * (only `publish` does), so on a clean checkout the tarball would otherwise
 * contain package.json and README and nothing else.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repoRoot = path.resolve(packageDir, "..");
const VITEST_VERSION = "3.2.4";

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(detail.replace(/^/gm, "        "));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/** `npm pack` a workspace and return the absolute tarball path. */
function pack(workspaceDir, destination) {
  const stdout = execFileSync(
    "npm",
    ["pack", "--pack-destination", destination, "--silent"],
    { cwd: workspaceDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  // `npm pack --silent` still prints the filename; take the last non-empty
  // line so a stray warning above it does not become the path.
  const name = stdout.trim().split("\n").filter(Boolean).pop();
  return path.join(destination, name);
}

const workDir = mkdtempSync(path.join(os.tmpdir(), "mcpjam-vitest-pack-"));
let exitCode = 0;

try {
  console.log("packing workspaces...");
  // The SDK is packed too: the fixture must consume the same build a publish
  // would ship, not the workspace symlink.
  const evaluatorTarball = pack(path.join(repoRoot, "evaluators"), workDir);
  const sdkTarball = pack(path.join(repoRoot, "sdk"), workDir);
  const vitestTarball = pack(packageDir, workDir);
  console.log(`  sdk    ${path.basename(sdkTarball)}`);
  console.log(`  vitest ${path.basename(vitestTarball)}`);

  const fixtureDir = path.join(workDir, "fixture");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    path.join(fixtureDir, "package.json"),
    `${JSON.stringify(
      {
        name: "packaging-fixture",
        version: "1.0.0",
        private: true,
        type: "module",
      },
      null,
      2
    )}\n`
  );

  console.log("installing the tarballs into a clean project...");
  const install = run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
      evaluatorTarball,
      sdkTarball,
      vitestTarball,
      `vitest@${VITEST_VERSION}`,
      "typescript@5.9.3",
      "@types/node@22",
    ],
    { cwd: fixtureDir }
  );
  if (install.status !== 0) {
    console.log(install.stdout);
    console.error(install.stderr);
    throw new Error(`npm install failed with status ${install.status}`);
  }

  // A stub executor written the way a CONSUMER would have to write one, from
  // the public entry alone. If the package's exports are insufficient for
  // this, the E2E fails here rather than in someone's repo.
  const support = `
import { PromptResult } from "@mcpjam/sdk";

export class StubExecutor {
  constructor(turn = {}) {
    this.turn = turn;
    this.history = [];
  }
  async run(prompt) {
    const result = new PromptResult({
      prompt,
      messages: [],
      text: this.turn.text ?? "ok",
      toolCalls: this.turn.toolCalls ?? [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      latency: { e2eMs: 1, llmMs: 1, mcpMs: 0 },
    });
    this.history.push(result);
    return result;
  }
  withOptions() { return this; }
  getPromptHistory() { return this.history; }
  resetPromptHistory() { this.history = []; }
}

export function suiteOf(EvalSuite, EvalTest, cases) {
  const suite = new EvalSuite({ name: "packaging suite" });
  for (const entry of cases) {
    suite.add(new EvalTest({
      // \`id\` is the case's declared identity and is required by @mcpjam/sdk.
      // Passed through from the scenario so the packaged tarball is exercised
      // against the same shape a consumer writes. Where a scenario also sets
      // \`externalCaseId\`, the two carry the SAME value: they are two claims
      // about one case, and @mcpjam/sdk rejects a differing pair. The scenarios
      // keep the external id because the \`[id]\` title suffix is derived from
      // it, and the output assertions below match on that suffix.
      id: entry.id,
      name: entry.name,
      ...(entry.externalCaseId ? { externalCaseId: entry.externalCaseId } : {}),
      test: async (executor) => {
        await executor.run("go");
        return entry.passes;
      },
    }));
  }
  return suite;
}
`;
  writeFileSync(path.join(fixtureDir, "support.mjs"), support);

  const FAILING_CASE_TITLE = "a case that fails [case_red]";

  const scenarios = [
    {
      label: "a passing suite exits 0",
      file: "pass.test.mjs",
      expectZero: true,
      expectInOutput: ["a case that passes [case_green]"],
      body: `
import { EvalSuite, EvalTest } from "@mcpjam/sdk";
import { describeEvalSuite } from "@mcpjam/vitest";
import { StubExecutor, suiteOf } from "./support.mjs";

describeEvalSuite("packaged suite", suiteOf(EvalSuite, EvalTest, [
  { id: "case_green", name: "a case that passes", externalCaseId: "case_green", passes: true },
]), {
  executor: new StubExecutor(),
  run: { iterations: 1, mcpjam: { enabled: false } },
  gate: { minimumPassRate: 1 },
});
`,
    },
    {
      label: "a failing case exits non-zero and names the case",
      file: "fail-case.test.mjs",
      expectZero: false,
      expectInOutput: [FAILING_CASE_TITLE],
      body: `
import { EvalSuite, EvalTest } from "@mcpjam/sdk";
import { describeEvalSuite } from "@mcpjam/vitest";
import { StubExecutor, suiteOf } from "./support.mjs";

describeEvalSuite("packaged suite", suiteOf(EvalSuite, EvalTest, [
  { id: "case_red", name: "a case that fails", externalCaseId: "case_red", passes: false },
]), {
  executor: new StubExecutor(),
  run: { iterations: 1, mcpjam: { enabled: false } },
});
`,
    },
    {
      label: "a breached gate exits non-zero and prints the gate table",
      file: "fail-gate.test.mjs",
      expectZero: false,
      // Every CASE passes here. Only the policy is breached, so the failure
      // has to come from the gate test and carry the formatted report.
      //
      // The gate must be FAILED, not a usage error. `minimumPassRate: 1.5`
      // looked like a convenient always-fail and is actually rejected as an
      // out-of-range threshold, which would have proved only that bad input
      // fails the build — a different outcome with a different exit meaning.
      expectInOutput: ["eval gate", "Gate: FAILED", "maximumP95LatencyMs"],
      body: `
import { EvalSuite, EvalTest } from "@mcpjam/sdk";
import { describeEvalSuite } from "@mcpjam/vitest";
import { StubExecutor, suiteOf } from "./support.mjs";

describeEvalSuite("packaged suite", suiteOf(EvalSuite, EvalTest, [
  { id: "case_green", name: "a case that passes", externalCaseId: "case_green", passes: true },
]), {
  executor: new StubExecutor(),
  run: { iterations: 1, mcpjam: { enabled: false } },
  // A VALID policy this run cannot meet: the stub reports 1ms of latency, so
  // a 0ms ceiling is breached while every case still passes.
  gate: { minimumPassRate: 1, maximumP95LatencyMs: 0 },
});
`,
    },
  ];

  scenarios.push(
    {
      label:
        "canonical authoring and declared measurements work from installed artifacts",
      file: "canonical.test.mjs",
      expectZero: true,
      expectInOutput: ["passes", "Reporting: not_requested"],
      body: `
import { EvalTest, assertion } from "@mcpjam/sdk";
import { testEval } from "@mcpjam/vitest";
import { StubExecutor } from "./support.mjs";
testEval(new EvalTest({ id: "canonical", name: "canonical", reported: [{id:"quality",version:"1"}],
execute: async (executor,ctx) => { await executor.run("go"); ctx.report("quality", 0.8); },
evaluators: { mode:"extend", list:[assertion({type:"noToolErrors"})] } }),
{executor:new StubExecutor(),run:{iterations:1,mcpjam:{enabled:false}},gate:{minimumPassRate:1}});
`,
    },
    {
      label: "skip does not instantiate an executor",
      file: "skip.test.mjs",
      expectZero: true,
      expectInOutput: ["skipped"],
      body: `
import { it, expect } from "vitest";
import { EvalTest } from "@mcpjam/sdk";
import { testEval } from "@mcpjam/vitest";
let factories=0;
testEval.skip(new EvalTest({id:"skip",name:"skipped",execute:()=>{throw new Error("executed")}}),
{factory:()=>{factories++;throw new Error("factory invoked")},run:{iterations:1}});
it("factory remains unused",()=>expect(factories).toBe(0));
`,
    },
    {
      label: "focused evals obey CI allowOnly prohibition",
      file: "focused.test.mjs",
      expectZero: false,
      expectInOutput: ["only"],
      body: `
import { EvalTest } from "@mcpjam/sdk";
import { testEval } from "@mcpjam/vitest";
import { StubExecutor } from "./support.mjs";
testEval.only(new EvalTest({id:"only",name:"focused",execute:()=>{}}),{executor:new StubExecutor(),run:{iterations:1,mcpjam:{enabled:false}}});
`,
    },
    {
      label:
        "cleanup runs when strict reporting fails, and local evidence remains",
      file: "cleanup.test.mjs",
      expectZero: false,
      expectInOutput: ["DISPOSED_WITH_LOCAL_EVIDENCE", "Reporting: failed"],
      body: `
import { EvalTest } from "@mcpjam/sdk";
import { testEval } from "@mcpjam/vitest";
import { StubExecutor } from "./support.mjs";
globalThis.fetch=async()=>({ok:false,status:400,json:async()=>({error:"rejected"})});
const test=new EvalTest({id:"cleanup",name:"strict persistence",execute:async executor=>{await executor.run("go")}});
testEval(test,{executor:new StubExecutor(),run:{iterations:1,mcpjam:{apiKey:"test-key",strict:true,baseUrl:"https://example.invalid"}},
dispose:()=>{if(test.getResults()?.successes===1 && test.getReportingReceipt().state==="failed") console.log("DISPOSED_WITH_LOCAL_EVIDENCE")}});
`,
    }
  );

  writeFileSync(
    path.join(fixtureDir, "consumer.ts"),
    `
import { EvalTest, EvalSuite, assertion, type EvalExecutionContext, type RunEvaluator, selectionStability, runVariants } from "@mcpjam/sdk";
import { testEval, describeEvalSuite } from "@mcpjam/vitest";
const evaluator: RunEvaluator = selectionStability();
const test = new EvalTest({id:"typed",name:"typed",execute: async (_executor, ctx:EvalExecutionContext)=>{ctx.report("quality",0.8)},reported:[{id:"quality",version:"1"}],evaluators:{mode:"extend",list:[assertion({type:"noToolErrors"})]},runEvaluators:[evaluator]});
const suite = new EvalSuite({name:"typed",defaults:{iterations:1,evaluators:[assertion({type:"noToolErrors"})]}}); suite.add(test);
void testEval; void describeEvalSuite; void runVariants;
`
  );
  const enterpriseDoc = readFileSync(
    path.join(repoRoot, "docs/sdk/concepts/enterprise-evals.mdx"),
    "utf8"
  );
  const enterpriseExample = enterpriseDoc.match(
    /```typescript\n([\s\S]*?)```/
  )?.[1];
  if (!enterpriseExample)
    throw new Error("Enterprise eval documentation example is missing");
  writeFileSync(
    path.join(fixtureDir, "enterprise-example.ts"),
    enterpriseExample
  );
  const compile = run(
    "npx",
    [
      "tsc",
      "--noEmit",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.ts",
      "enterprise-example.ts",
    ],
    { cwd: fixtureDir }
  );
  check(
    "installed TypeScript consumer and enterprise documentation example compile",
    compile.status === 0,
    `${compile.stdout ?? ""}${compile.stderr ?? ""}`
  );

  for (const scenario of scenarios) {
    writeFileSync(path.join(fixtureDir, scenario.file), scenario.body);
  }

  console.log("running child vitest processes...");
  for (const scenario of scenarios) {
    const result = run(
      "npx",
      ["vitest", "run", scenario.file, "--reporter", "verbose"],
      {
        cwd: fixtureDir,
        env: {
          ...process.env,
          CI: "true",
          MCPJAM_API_KEY: "",
          MCPJAM_RUN_METADATA: "",
          MCPJAM_RUN_NAME: "",
          MCPJAM_RUN_TAGS: "",
        },
      }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const zero = result.status === 0;

    check(
      `${scenario.label} (exit ${result.status})`,
      zero === scenario.expectZero,
      zero === scenario.expectZero ? undefined : output
    );
    for (const needle of scenario.expectInOutput) {
      check(
        `  output contains ${JSON.stringify(needle)}`,
        output.includes(needle),
        output.includes(needle) ? undefined : output
      );
    }
  }

  // The tarball must not ship sources or tests — `files: ["dist"]` is the
  // claim, and a stray `src/` would mean consumers compile our TypeScript.
  const installedDir = path.join(
    fixtureDir,
    "node_modules",
    "@mcpjam",
    "vitest"
  );
  const shipped = readdirSync(installedDir).sort();
  check(
    `tarball ships only dist + metadata (${shipped.join(", ")})`,
    !shipped.includes("src") &&
      !shipped.includes("tests") &&
      shipped.includes("dist")
  );
} catch (error) {
  failures += 1;
  console.error(
    `\nharness error: ${error instanceof Error ? error.stack : error}`
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} packaging check(s) failed.`);
  exitCode = 1;
} else {
  console.log("\nall packaging checks passed.");
}

process.exitCode = exitCode;
