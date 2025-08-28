import { createServer } from "http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Test } from "../../schemas/test-schema.js";
import type { EnvironmentFile } from "../../schemas/environment-schema.js";
import { createTestsRouter } from "../server/tests-router.js";

async function findAvailablePort(startPort = 3500): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const port = (server.address() as any)?.port;
      server.close(() => {
        resolve(port || startPort);
      });
    });
    server.on("error", () => {
      resolve(startPort);
    });
  });
}

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

  // Find an available port
  const port = await findAvailablePort();
  const server = serve({
    fetch: app.fetch,
    port,
  });

  // Wait a moment for server to start
  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    // Convert tests to backend format
    const backendTests = tests.map((test, index) => ({
      id: `test_${index}`,
      title: test.title,
      prompt: test.prompt,
      expectedTools: test.expectedTools,
      model: test.model,
      selectedServers: test.selectedServers,
    }));

    // Convert environment to backend format
    const backendServers = Object.fromEntries(
      Object.entries(environment.mcpServers).map(([name, config]) => [
        name,
        convertServerConfig(config),
      ]),
    );

    const payload = {
      tests: backendTests,
      allServers: backendServers,
      providerApiKeys: environment.providerApiKeys || {},
    };

    // Make request to backend
    const response = await fetch(`http://localhost:${port}/mcp/tests/run-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `Server error: ${response.status} ${response.statusText}`,
      );
    }

    // Process streaming response
    const results = await processStreamingResults(response, tests);

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
    // STDIO server
    return {
      command: config.command,
      args: config.args || [],
      env: config.env || {},
    };
  } else {
    // HTTP server - keep URL as string per schema
    return {
      url: config.url,
      requestInit: {
        headers: config.headers || {},
      },
      eventSourceInit: {
        headers: config.headers || {},
      },
    };
  }
}

async function processStreamingResults(
  response: Response,
  tests: Test[],
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  if (!reader) {
    throw new Error("No response body");
  }

  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete lines
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") break;

        try {
          const event = JSON.parse(data);

          if (event.type === "result") {
            const testIndex = parseInt(event.testId.split("_")[1]);
            const test = tests[testIndex];
            const testStart = Date.now();

            const result: TestResult = {
              testId: event.testId,
              title: test?.title || "Unknown Test",
              passed: event.passed,
              calledTools: event.calledTools || [],
              missingTools: event.missingTools || [],
              unexpectedTools: event.unexpectedTools || [],
              error: event.error,
              duration: 0, // We don't have individual timing from the stream
            };

            results.push(result);

            // Print result immediately
            if (result.passed) {
              console.log(`✅ ${result.title}`);
              console.log(
                `   Called tools: ${result.calledTools.join(", ") || "none"}`,
              );
            } else {
              console.log(`❌ ${result.title}`);
              if (result.error) {
                console.log(`   Error: ${result.error}`);
              } else {
                console.log(
                  `   Called tools: ${result.calledTools.join(", ") || "none"}`,
                );
                if (result.missingTools.length > 0) {
                  console.log(`   Missing: ${result.missingTools.join(", ")}`);
                }
                if (result.unexpectedTools.length > 0) {
                  console.log(
                    `   Unexpected: ${result.unexpectedTools.join(", ")}`,
                  );
                }
              }
            }
          } else if (event.type === "trace_step") {
            // Optional: could show progress steps
          }
        } catch (e) {
          // Ignore malformed JSON
        }
      }
    }
  }

  return results;
}
