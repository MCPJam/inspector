import type { PreparedRunInput } from "./prepared-eval-server-page";
import type { EvalSuite } from "../evals/types";

type Mutation = (name: string, args: Record<string, unknown>) => Promise<any>;
/** Idempotent authoring: a failed launch can resume without duplicating cases. */
export async function savePreparedEvalSuites(
  input: PreparedRunInput & {
    projectId: string;
    server: { id: string; name: string };
    mutate: Mutation;
  },
): Promise<EvalSuite[]> {
  const suites = input.suites.filter((suite) => suite.cases.length);
  if (!suites.length)
    throw new Error("Select at least one case before running.");
  if (!input.clients.length)
    throw new Error("Select a configured client before running.");
  for (const suite of suites)
    for (const test of suite.cases) {
      if (!test.steps?.length)
        throw new Error(
          `“${test.title}” needs executable steps before it can run.`,
        );
    }
  const result: EvalSuite[] = [];
  for (const suite of suites) {
    const saved = await input.mutate("testSuites:createTestSuite", {
      projectId: input.projectId,
      name: `${input.server.name}: ${suite.title}`,
      description: suite.description,
      environment: { servers: [input.server.name] },
      namedHostId: input.clients[0].id,
      hostAttachments: input.clients.map((client) => ({
        namedHostId: client.id,
        selectedServerIds: [input.server.id],
      })),
      idempotencyKey: `prepared:${input.reviewKey}:${suite.id}`,
    });
    if (!saved?._id) throw new Error("Could not save the prepared suite.");
    for (const test of suite.cases) {
      if (!test.steps?.length)
        throw new Error(
          `“${test.title}” needs executable steps before it can run.`,
        );
      await input.mutate("testSuites:createTestCase", {
        suiteId: saved._id,
        title: test.title,
        query: test.prompt ?? test.title,
        steps: test.steps,
        expectedOutput: test.expectedOutput ?? "",
        models: [],
        runs: input.iterationsPerCase,
        ...(test.matchOptions ? { matchOptions: test.matchOptions } : {}),
        ...(test.predicates ? { predicates: test.predicates } : {}),
        idempotencyKey: `prepared:${input.reviewKey}:${test.id}`,
      });
    }
    result.push(saved);
  }
  return result;
}
