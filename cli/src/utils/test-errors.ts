export class TestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: any,
  ) {
    super(message);
    this.name = "TestError";
  }
}

export class ModelError extends TestError {
  constructor(provider: string, modelId: string, originalError: string) {
    const message = formatModelError(provider, originalError);
    super(message, "MODEL_ERROR", { provider, modelId, originalError });
  }
}

export class ServerConnectionError extends TestError {
  constructor(serverName: string, originalError: string) {
    super(
      `Failed to connect to server '${serverName}': ${originalError}`,
      "SERVER_CONNECTION_ERROR",
      {
        serverName,
        originalError,
      },
    );
  }
}

export class ValidationError extends TestError {
  constructor(field: string, value: any, expected: string) {
    super(
      `Invalid ${field}: expected ${expected}, got ${value}`,
      "VALIDATION_ERROR",
      {
        field,
        value,
        expected,
      },
    );
  }
}

function formatModelError(provider: string, originalError: string): string {
  const lowerError = originalError.toLowerCase();

  if (
    lowerError.includes("api key") ||
    lowerError.includes("401") ||
    lowerError.includes("unauthorized") ||
    lowerError.includes("authentication")
  ) {
    return `Invalid or missing API key for ${provider}. Check your API key configuration.`;
  }

  if (lowerError.includes("model") && lowerError.includes("not found")) {
    return `Model not found for ${provider}. Check if the model ID is correct.`;
  }

  if (lowerError.includes("quota") || lowerError.includes("rate limit")) {
    return `Rate limit or quota exceeded for ${provider}. Try again later.`;
  }

  return `Failed to create ${provider} model: ${originalError}`;
}

export function createTestResult(
  testId: string,
  title: string,
  passed: boolean,
  error?: string,
  calledTools: string[] = [],
  missingTools: string[] = [],
  unexpectedTools: string[] = [],
) {
  return {
    testId,
    title,
    passed,
    calledTools,
    missingTools,
    unexpectedTools,
    error,
    duration: 0,
  };
}
