/**
 * The conformance run a local runtime owes, picked by how it authenticates
 * (`LocalRuntime.credential`): a full turn through the model gateway
 * (`run-gateway-turn.ts`), or, for a runtime on its vendor's own login, the
 * lifecycle around one (`run-login-lifecycle.ts`). CI's runtime legs run this,
 * so a runtime made local is covered by whichever applies.
 *
 *   HOME=<scratch>/home CONFORMANCE_ROOT=<scratch> \
 *     npx tsx run-runtime-conformance.ts <harnessId>
 */
import { localRuntimeOf } from "../runtimes/index.js";

const harnessId = process.argv[2] ?? "";
const runtime = localRuntimeOf(harnessId);
if (runtime === undefined) throw new Error(`${JSON.stringify(harnessId)} is not a local runtime`);
// Each driver reads the harness id from argv and runs when imported.
await import(runtime.credential.kind === "gateway" ? "./run-gateway-turn.js" : "./run-login-lifecycle.js");
