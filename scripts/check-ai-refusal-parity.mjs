/**
 * Compares the SDK's AI refusal vocabulary (`sdk/src/ai-refusal-codes.ts`)
 * with the backend's (`convex/lib/aiKeyPolicy.ts`): the policy's own codes,
 * the reused codes, and which codes lift on their own. The CLI, the SDK and
 * the inspector all derive from the SDK copy, so this is the one comparison
 * that keeps them honest about the backend.
 *
 *   node scripts/check-ai-refusal-parity.mjs --backend <backend checkout>
 *
 * The SDK side is imported, so the comparison uses the values the code
 * actually exports. The backend side is read as text, because its module
 * needs Convex to load.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const index = process.argv.indexOf("--backend");
if (index < 0 || !process.argv[index + 1]) {
  throw new Error("Usage: check-ai-refusal-parity.mjs --backend <checkout>");
}
const backendText = readFileSync(
  resolve(process.argv[index + 1], "convex/lib/aiKeyPolicy.ts"),
  "utf8"
);

/** The body of the first `pattern` match, or a failure naming `what`. */
function region(pattern, what) {
  const match = pattern.exec(backendText);
  if (!match) throw new Error(`The backend's ${what} was not found.`);
  return match[1];
}

/** Every quoted code in an array body, in order. */
function codesIn(body) {
  return [...body.matchAll(/^\s*['"]([a-z_]+)['"],?\s*$/gm)].map((m) => m[1]);
}

const backend = {
  execution: codesIn(
    region(
      /export const AI_EXECUTION_REFUSAL_CODES = \[([\s\S]*?)\] as const;/,
      "AI_EXECUTION_REFUSAL_CODES"
    )
  ),
  reused: codesIn(
    region(
      /export const AI_REUSED_REFUSAL_CODES = \[([\s\S]*?)\] as const;/,
      "AI_REUSED_REFUSAL_CODES"
    )
  ),
  retryable: Object.fromEntries(
    [
      ...region(
        /const RETRYABLE_BY_CODE: Readonly<Record<AiRefusalCode, boolean>> = \{([\s\S]*?)\};/,
        "RETRYABLE_BY_CODE"
      ).matchAll(/^\s*([a-z_]+): (true|false),?\s*$/gm),
    ].map((m) => [m[1], m[2] === "true"])
  ),
};

const sdk = await import(
  pathToFileURL(resolve(root, "sdk/src/ai-refusal-codes.ts")).href
);
const local = {
  execution: [...sdk.AI_EXECUTION_REFUSAL_CODES],
  reused: [...sdk.AI_REUSED_REFUSAL_CODES],
  retryable: Object.fromEntries(
    sdk.AI_REFUSAL_CODES.map((code) => [
      code,
      sdk.aiRefusalClass(code) === "temporary",
    ])
  ),
};

if (backend.execution.length === 0 || backend.reused.length === 0) {
  throw new Error("The backend's code lists parsed as empty.");
}
const backendCodes = [...backend.execution, ...backend.reused].sort();
const tableCodes = Object.keys(backend.retryable).sort();
if (JSON.stringify(tableCodes) !== JSON.stringify(backendCodes)) {
  throw new Error("The backend's retry table does not cover exactly its codes.");
}

const problems = [];
for (const key of ["execution", "reused"]) {
  if (JSON.stringify(local[key]) !== JSON.stringify(backend[key])) {
    problems.push(
      `${key} codes differ.\n  SDK:     ${local[key].join(", ")}\n  backend: ${backend[key].join(", ")}`
    );
  }
}
for (const code of backendCodes) {
  if (local.retryable[code] !== backend.retryable[code]) {
    const sdkClass = local.retryable[code] ? "temporary" : "configuration";
    const backendClass = backend.retryable[code] ? "retryable" : "permanent";
    problems.push(
      `${code}: the SDK says ${sdkClass}, the backend says ${backendClass}.`
    );
  }
}
if (problems.length > 0) {
  throw new Error(
    `The SDK's AI refusal vocabulary differs from the backend's:\n${problems.join("\n")}`
  );
}
console.log("AI refusal vocabulary matches the backend.");
