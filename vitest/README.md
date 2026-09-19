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
  run: { iterations: 25, runTimeoutMs: 240_000, mcpjam: { strict: true } },
  gate: {
    minimumPassRate: 0.9,
    maximumP95LatencyMs: 30_000,
    noGatingScoreErrors: true,
  },
});
```

Set `MCPJAM_API_KEY` in CI. Strict reporting fails the test when evidence cannot be persisted, while keeping the completed local measurements available through `getResults()` and `getReportingReceipt()`. For an intentional local-only run, set `mcpjam: { enabled: false }`.

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
| `run` | SDK execution controls: `iterations` (or suite `defaults.iterations`), `concurrency`, `timeoutMs`, `runTimeoutMs`, `evaluatorTimeoutMs`, `maxCapturedBytes`, `signal`, `mcpjam`, … |
| `gate` | A `GatePolicy`. Omit to register no gate test. |
| `hookTimeoutMs` | Vitest hook timeout. Default 300000. Configure SDK execution bounds separately. |
| `dispose` | Optional async cleanup for the executor, invoked in `afterAll` even after failure. |
| `summary` | `table` by default, or `none`. Reports measurements and persistence separately. |
| `only` / `skip` | Suite case IDs to focus/skip. Skip wins; unknown IDs are rejected. |

### `testEval(test, options)`

The single-test seat, for a file that owns one eval and wants no suite.

```ts
import { EvalTest, assertion } from "@mcpjam/sdk";
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
    execute: async (executor) => {
      await executor.run("refund the duplicate charge");
    },
    evaluators: {
      mode: "extend",
      list: [assertion({ type: "toolCalledAtLeastOnce", toolName: "create_refund" })],
    },
  }),
  { factory: () => buildExecutor(), run: { iterations: 25, mcpjam: { strict: true } } }
);
```

The nested case test is named `passes`; its outer title retains the case's name and hosted ID.
Both facades expose `.skip(...)` and `.only(...)`. Skipped registrations never construct an executor.
Focused registrations use Vitest's native focus behavior and are rejected when CI disables `allowOnly`.

Suite filtering preserves the original case inventory. A gate over a subset is incomplete by default;
use `gate.selectionScope: "selected"` only when intentionally certifying that selection. Hosted subset
reporting is currently refused until persisted selection support is available; use `mcpjam.enabled: false`
for local filtered runs. Skipping everything produces no execution and no passing acceptance claim.

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
irrelevant to execution. Set `hookTimeoutMs` above the SDK run deadline. The SDK uses separate iteration, evaluator, and run bounds; its abort signal is cooperative for custom external side effects. `maxCapturedBytes` defaults to 16 MiB per iteration and bounds retained SDK evidence. Exceeding it returns unavailable capture with evaluator error rows and drops the oversized transcript from the result. It does not cap allocations inside your executor or custom code.

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
