export type EvaluationResult = {
  expectedToolCalls: string[];
  toolsCalled: string[];
  missing: string[];
  unexpected: string[];
  passed: boolean;
};

export const evaluateResults = (
  expectedToolCalls: string[],
  toolsCalled: string[],
) => {
  return {
    expectedToolCalls,
    toolsCalled,
    missing: expectedToolCalls.filter((tool) => !toolsCalled.includes(tool)),
    unexpected: toolsCalled.filter((tool) => !expectedToolCalls.includes(tool)),
    passed: expectedToolCalls.every((tool) => toolsCalled.includes(tool)),
  };
};
