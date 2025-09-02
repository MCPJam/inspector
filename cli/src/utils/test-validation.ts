import { ValidationError } from "./test-errors.js";

export interface TestPayload {
  test: {
    id: string;
    title: string;
    prompt: string;
    expectedTools: string[];
    model: { id: string; provider: string };
    selectedServers?: string[];
  };
  allServers: Record<string, any>;
  providerApiKeys: Record<string, string>;
}

export function validateTest(test: any): void {
  if (!test) {
    throw new ValidationError("test", test, "non-null object");
  }

  if (!test.id || typeof test.id !== "string") {
    throw new ValidationError("test.id", test.id, "non-empty string");
  }

  if (!test.title || typeof test.title !== "string") {
    throw new ValidationError("test.title", test.title, "non-empty string");
  }

  if (!test.model || typeof test.model !== "object") {
    throw new ValidationError("test.model", test.model, "object");
  }

  if (!test.model.id || typeof test.model.id !== "string") {
    throw new ValidationError(
      "test.model.id",
      test.model.id,
      "non-empty string",
    );
  }

  if (!test.model.provider || typeof test.model.provider !== "string") {
    throw new ValidationError(
      "test.model.provider",
      test.model.provider,
      "non-empty string",
    );
  }
}

export function validateServerConfigs(
  serverConfigs: Record<string, any>,
  selectedServers?: string[],
): Record<string, any> {
  let validConfigs: Record<string, any> = {};

  if (selectedServers && selectedServers.length > 0) {
    for (const name of selectedServers) {
      if (serverConfigs[name]) {
        validConfigs[name] = serverConfigs[name];
      }
    }
  } else {
    validConfigs = serverConfigs;
  }

  if (Object.keys(validConfigs).length === 0) {
    throw new ValidationError(
      "serverConfigs",
      validConfigs,
      "at least one valid server configuration",
    );
  }

  return validConfigs;
}

export function analyzeToolResults(
  calledTools: Set<string>,
  expectedTools: string[] = [],
) {
  const called = Array.from(calledTools);
  const expectedSet = new Set(expectedTools);
  const missing = expectedTools.filter((t) => !calledTools.has(t));
  const unexpected = called.filter((t) => !expectedSet.has(t));
  const passed = missing.length === 0 && unexpected.length === 0;

  return {
    called,
    missing,
    unexpected,
    passed,
  };
}
