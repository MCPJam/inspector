import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Test } from "../../schemas/test-schema.js";
import type { EnvironmentFile } from "../../schemas/environment-schema.js";
import { createTestsRouter } from "../server/tests-router.js";
import { Logger } from "../utils/logger.js";
import { createTestResult } from "../utils/test-errors.js";
import { findAvailablePort } from "../utils/utils.js";

export interface TestResult {
  testId: string;
  title: string;
  passed: boolean;
  calledTools: string[];
  missingTools: string[];
  unexpectedTools: string[];
  error?: string;
  duration: number;
}

export interface TestRunResults {
  passed: number;
  failed: number;
  duration: string;
  results: TestResult[];
}

export async function runTests(
  tests: Test[],
  environment: EnvironmentFile,
): Promise<TestRunResults> {
  const startTime = Date.now();

  // Start temporary backend server
  const app = new Hono();
  app.route("/mcp/tests", createTestsRouter());

  const port = await findAvailablePort();
  const server = serve({
    fetch: app.fetch,
    port,
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    const backendServers = convertServersConfig(environment.mcpServers);

    const results: TestResult[] = [];

    for (let i = 0; i < tests.length; i++) {
      const test = tests[i];
      if (!test) {
        throw new Error(`Test ${i} is undefined`);
      }

      const payload = {
        test: { ...test, id: `test_${i}` },
        allServers: backendServers,
        providerApiKeys: environment.providerApiKeys || {},
      };

      try {
        const response = await fetch(`http://localhost:${port}/mcp/tests/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(
            `Server error: ${response.status} ${response.statusText}`,
          );
        }

        const result = (await response.json()) as TestResult;
        const testResult = { ...result, title: test.title, duration: 0 };

        results.push(testResult);
        Logger.testResult(testResult);
      } catch (testError) {
        const errorMessage = (testError as Error)?.message || "Unknown error";
        const testResult = createTestResult(
          `test_${i}`,
          test.title,
          false,
          errorMessage,
          [],
          test.expectedTools || [],
          [],
        );

        results.push(testResult);
        Logger.testResult(testResult);
      }
    }

    await cleanupServerConnections(port);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    return {
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      duration,
      results,
    };
  } finally {
    if (server && typeof server.close === "function") {
      server.close();
    }
  }
}

function convertServerConfig(config: any): any {
  if ("command" in config) {
    return {
      command: config.command,
      args: config.args || [],
      env: config.env || {},
    };
  }

  return {
    url: config.url,
    requestInit: { headers: config.headers || {} },
    eventSourceInit: { headers: config.headers || {} },
  };
}

function convertServersConfig(
  mcpServers: Record<string, any>,
): Record<string, any> {
  return Object.fromEntries(
    Object.entries(mcpServers).map(([name, config]) => [
      name,
      convertServerConfig(config),
    ]),
  );
}

async function cleanupServerConnections(port: number): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/mcp/tests/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  } catch (cleanupError) {
    console.warn("Warning: Failed to cleanup server connections");
  }
}
