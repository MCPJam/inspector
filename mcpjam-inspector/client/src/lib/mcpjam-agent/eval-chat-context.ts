import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
} from "@/components/evals/types";

/** Authoring context is coverage and outcomes, not a copy of recorded traces. */
export function evalChatSuiteContext(
  suite: EvalSuite,
  cases: EvalCase[],
  runs: EvalSuiteRun[],
  iterations: EvalIteration[],
) {
  return {
    suite: {
      _id: suite._id,
      name: suite.name,
      description: suite.description,
      environment: suite.environment,
      environmentIds: suite.environmentIds,
      hostAttachments: suite.hostAttachments,
      defaultPassCriteria: suite.defaultPassCriteria,
    },
    caseCount: cases.length,
    cases: cases.slice(0, 100).map((item) => ({
      _id: item._id,
      title: item.title,
      query: item.query?.slice(0, 2000),
      models: item.models,
      expectedTools: item.expectedToolCalls?.map((call) => call.toolName),
    })),
    casesOmitted: Math.max(0, cases.length - 100),
    runCount: runs.length,
    runs: [...runs]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20)
      .map((run) => ({
        _id: run._id,
        runNumber: run.runNumber,
        runGroupId: run.runGroupId,
        status: run.status,
        result: run.result,
        summary: run.summary,
        namedHostId: run.namedHostId,
        effectiveModelId: run.effectiveModelId,
        createdAt: run.createdAt,
      })),
    iterationCount: iterations.length,
    note: "Run traces, tool outputs, and snapshots are omitted. Open a case to read and edit its complete steps; generation discovers live server tools separately.",
  };
}

/** Shrink old context tool results on the wire too, so an oversized thread can recover. */
export function compactEvalContextMessages<
  T extends { parts: readonly unknown[] },
>(messages: T[]): T[] {
  return messages.map(
    (message) =>
      ({
        ...message,
        parts: message.parts.map((part: any) => {
          if (
            part?.type !== "tool-ui_eval_context" &&
            !(
              part?.type === "dynamic-tool" &&
              part.toolName === "ui_eval_context"
            )
          )
            return part;
          if (!Array.isArray(part.output?.content)) return part;
          return {
            ...part,
            output: {
              ...part.output,
              content: part.output.content.map((block: any) => {
                if (block.type !== "text") return block;
                try {
                  const value = JSON.parse(block.text);
                  const context = value.suite;
                  if (!context?.suite || !Array.isArray(context.iterations))
                    return block;
                  return {
                    ...block,
                    text: JSON.stringify({
                      ...value,
                      suite: evalChatSuiteContext(
                        context.suite,
                        context.cases ?? [],
                        context.runs ?? [],
                        context.iterations,
                      ),
                    }),
                  };
                } catch {
                  return block;
                }
              }),
            },
          };
        }),
      }) as T,
  );
}
