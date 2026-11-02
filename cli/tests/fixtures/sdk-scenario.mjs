// SDK child script for the deployment process tests. Runs one SDK Node entry
// point with whatever MCPJam settings the test put in the environment, and
// prints the outcome as its last stdout line, as JSON:
//
//   node sdk-scenario.mjs <report|lease|suite|saved-client|artifact> ['{"input":…}']
import {
  createModelFromString,
  EvalSuite,
  EvalTest,
  HostRunner,
  MCPClientManager,
  reportEvalResultsSafely,
  uploadEvalArtifact,
} from "@mcpjam/sdk";
import { generateText } from "ai";

const [mode, raw] = process.argv.slice(2);
const options = raw ? JSON.parse(raw) : {};
const MODEL = "mcpjam/anthropic/claude-haiku-4.5";

function leaseCase() {
  return new EvalTest({
    id: "c_lease",
    name: "mints a lease and asks the model",
    test: async (runner) => Boolean((await runner.run("Say hi.")).getText?.() ?? true),
  });
}

const scenarios = {
  async report() {
    const result = await reportEvalResultsSafely({
      suiteName: "deployment-fixture",
      apiKey: "sk_fixture",
      results: [{ caseTitle: "reaches the configured server", passed: true }],
      ...options.input,
    });
    return { runId: result?.runId ?? null };
  },
  async lease() {
    const model = createModelFromString(MODEL, { apiKey: "sk_fixture" });
    const { text } = await generateText({ model, prompt: "Say hi." });
    return { text };
  },
  async suite() {
    const suite = new EvalSuite({
      name: "lease suite",
      mcpjam: { apiKey: "sk_fixture", ...options.mcpjam },
    });
    suite.add(leaseCase());
    const runner = new HostRunner({ tools: {}, apiKey: "sk_fixture", model: MODEL });
    const result = await suite.run(runner, { iterations: 1 });
    return { passRate: result.aggregate?.accuracy ?? null };
  },
  async "saved-client"() {
    const suite = new EvalSuite({ name: "client suite", mcpjam: { apiKey: "sk_fixture" } });
    suite.add(leaseCase());
    await suite.runWithClient(
      {
        client: "client a",
        projectId: "project_a",
        apiKey: "sk_fixture",
        manager: new MCPClientManager({}),
      },
      { iterations: 1 },
    );
    return {};
  },
  async artifact() {
    const result = await uploadEvalArtifact({
      suiteName: "artifact",
      apiKey: "sk_fixture",
      format: "junit-xml",
      artifact:
        '<testsuite name="s" tests="1"><testcase classname="c" name="passes"/></testsuite>',
    });
    return { runId: result.runId };
  },
};

try {
  const outcome = await scenarios[mode]();
  process.stdout.write(`${JSON.stringify({ ok: true, ...outcome })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, code: error?.code, message: error?.message })}\n`,
  );
}
