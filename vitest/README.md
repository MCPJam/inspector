# @mcpjam/vitest

Run MCPJam eval suites inside vitest. One test per eval case, plus a gate test
that fails the build when the run breaches your policy.

```bash
npm install -D @mcpjam/vitest vitest
```

## The flagship: gate a hosted corpus in CI

Pull your hosted suite once with `mcpjam cloud eval pull`, commit the lock, and run
it locally on every change. The lock is the reproducibility record — the same
cases, graded the same way, until you pull again.

```ts
// evals/refunds.test.ts
import { readFile } from "node:fs/promises";
import { loadCorpusFromLock } from "@mcpjam/sdk";
import { describeEvalSuite } from "@mcpjam/vitest";
import { buildExecutor } from "./support/executor.js";

const lock = JSON.parse(await readFile("mcpjam-evals.lock.json", "utf8"));
const corpus = loadCorpusFromLock(lock);

describeEvalSuite("refund flows", corpus.toEvalSuite(), {
  factory: () => buildExecutor(),
  run: { iterations: 25 },
  gate: {
    minimumPassRate: 0.9,
    maximumP95LatencyMs: 30_000,
    noGatingScoreErrors: true,
  },
});
```

`vitest run` then reports one test per hosted case, titled with its dashboard
id:

```
 ✓ refund flows > refunds a duplicate charge [case_8Kd2]
 ✓ refund flows > refuses a refund past the window [case_9Fa1]
 × refund flows > eval gate
   → Gate: FAILED (score integrity: valid)
     PASS minimumPassRate: 47/50 iterations passed [threshold 0.9]
     FAIL maximumP95LatencyMs: p95 e2e latency 41200ms [threshold 30000]
```

## API

### `describeEvalSuite(name, suite, options)`

Registers a `describe` containing one `it` per eval case, and — when `gate` is
given — a final `it` for the policy.

| option | meaning |
| --- | --- |
| `executor` | A ready `HostExecutor`. |
| `factory` | Builds one inside `beforeAll`, for an executor that must connect first. Mutually exclusive with `executor`. |
| `run` | `EvalTestRunOptions`: `iterations`, `concurrency`, `timeoutMs`, `mcpjam`, … |
| `gate` | A `GatePolicy`. Omit to register no gate test. |
| `hookTimeoutMs` | Timeout for the whole suite run. Default 300000. |

### `testEval(test, options)`

The single-test seat, for a file that owns one eval and wants no suite.

```ts
import { EvalTest } from "@mcpjam/sdk";
import { mintCaseId } from "@mcpjam/sdk/contract";
import { testEval } from "@mcpjam/vitest";

// `id` is the case's identity and is required. Mint it ONCE (`mintCaseId()`
// prints one) and commit the literal — a case renamed from "Refund flow" to
// "Refunds" keeps its history because the id, not the name, is what history
// joins on. Never call `mintCaseId()` inline: an id regenerated on every run
// is not an identity.
testEval(
  new EvalTest({
    id: "c_V1StGXR8Z5jdHi6Bmy",
    name: "refunds a duplicate charge",
    test: async (executor) => {
      const result = await executor.run("refund the duplicate charge");
      return result.hasToolCall("create_refund");
    },
  }),
  { factory: () => buildExecutor(), run: { iterations: 25 } }
);
```

### `planEvalSuite(suite, options)`

Pure. Returns the titles that *would* be registered — useful for asserting your
own naming, or for building a different harness on the same rules. Each entry
also carries `caseId` (the case's declared id) so a custom reporter can key on
identity rather than on a title that gets renamed.

### `runAndAssertCase(run, testName, failureReport?)` · `gateFailureMessage(error)`

The two pure pieces the generated tests are built from, exported so you can
assert the failing path from an ordinary test.

## How it works, and why

**One run, many tests.** `suite.run()` is called once, in `beforeAll`. That is
not an optimization: the suite uploads a single hosted run, computes one
aggregate evaluation-config hash, and executes cases sequentially. Calling it
per test would produce N hosted runs and N aggregate hashes. Each `it` is an
assertion over that one already-computed result, so per-test timeouts are
irrelevant — the timeout that matters is `hookTimeoutMs`.

**A wrapper, not a reporter.** A vitest Reporter observes tests; it cannot
decide what a test *is*. Evals need the opposite, so failures land on named
tests in every vitest UI, watch mode and CI annotation that already exists. A
reporter would also have no seat for the gate, which is a verdict over the
whole run rather than any one case.

**The gate is its own test.** A run where every case passed can still breach a
latency or score-integrity gate. Giving the policy a named test means CI shows
*which* question failed instead of a bare non-zero exit.

**Scenario ids are explicit.** A case's title gets ` [caseId]` only when the
test carries an `externalCaseId` — never inferred from the test name. The
declared `id` is deliberately *not* what the suffix shows: that suffix is the
handle people grep the hosted dashboard with, so it keeps carrying
`externalCaseId`. The declared id is exposed on `planEvalSuite`'s `caseId`
instead.

## Supported vitest versions

Declared as a peer dependency: `>=3.2.0 <4`. Tested against **3.2.4**, and the
packaged tarball is exercised against it in CI on every run. **Vitest 4 is
unvalidated** — the peer range excludes it deliberately rather than optimistically.
