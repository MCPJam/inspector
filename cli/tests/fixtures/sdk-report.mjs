// SDK child script for the deployment process tests. Reports one eval result
// through the SDK's Node entry with whatever MCPJam settings the test put in
// the environment, and prints the outcome as one JSON line.
import { reportEvalResultsSafely } from "@mcpjam/sdk";

try {
  const result = await reportEvalResultsSafely({
    suiteName: "deployment-fixture",
    apiKey: "sk_fixture",
    results: [{ caseTitle: "reaches the configured server", passed: true }],
  });
  process.stdout.write(`${JSON.stringify({ ok: true, runId: result?.runId ?? null })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, code: error?.code, message: error?.message })}\n`,
  );
}
