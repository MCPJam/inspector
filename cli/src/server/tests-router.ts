import { Hono } from "hono";
import { Agent } from "@mastra/core/agent";
import { Logger } from "../utils/logger.js";
import { MCPJamClientManager } from "../../../server/services/mcpjam-client-manager.js";
import {
  createFlattenedTools,
  connectToServersWithLogging,
  cleanupConnections,
} from "../utils/utils.js";
import { createModel } from "../utils/model-factory.js";
import {
  validateTest,
  validateServerConfigs,
  analyzeToolResults,
} from "../utils/test-validation.js";
import { createTestResult } from "../utils/test-errors.js";

export function createTestsRouter() {
  const tests = new Hono();
  let connectionManager: MCPJamClientManager | null = null;
  let connectedServers = new Set<string>();

  tests.post("/run", async (c) => {
    try {
      const body = await c.req.json();
      const { test, allServers = {}, providerApiKeys = {} } = body;

      validateTest(test);

      if (!connectionManager) {
        connectionManager = new MCPJamClientManager();
      }

      Logger.testStarting(test.title);
      const calledTools = new Set<string>();

      const serverConfigs = validateServerConfigs(
        allServers,
        test.selectedServers,
      );

      try {
        await connectToServersWithLogging(connectionManager, serverConfigs);
        Object.keys(serverConfigs).forEach((name) =>
          connectedServers.add(name),
        );

        const model = createModel(test.model, providerApiKeys);
        const flattenedTools = createFlattenedTools(
          connectionManager.getAvailableTools(),
        );

        const agent = new Agent({
          name: `TestAgent-${test.id}`,
          instructions: "You are a helpful assistant with access to MCP tools",
          model,
          tools: flattenedTools,
        });

        const executeOptions: any = {
          maxSteps: 15,
          timeout: 60000, // 60 second timeout
        };

        const result = await agent.generate(
          [{ role: "user", content: test.prompt || "" }] as any,
          executeOptions,
        );

        // Extract tool calls from the execution result
        if (result.steps) {
          for (let i = 0; i < result.steps.length; i++) {
            const step = result.steps[i];
            if (step) {
              if (step.toolCalls) {
                for (const toolCall of step.toolCalls) {
                  const toolName = toolCall?.toolName;
                  if (toolName) {
                    Logger.toolCall(toolName);
                    calledTools.add(toolName);
                  }
                }
              }
            }
          }
        }

        const { called, missing, unexpected, passed } = analyzeToolResults(
          calledTools,
          test.expectedTools,
        );

        return c.json({
          success: true,
          testId: test.id,
          passed,
          calledTools: called,
          missingTools: missing,
          unexpectedTools: unexpected,
        });
      } catch (err) {
        const errorMessage = (err as Error)?.message || "Unknown error";
        Logger.testError(test.title, errorMessage);

        const failedResult = createTestResult(
          test.id,
          test.title,
          false,
          errorMessage,
          [],
          test.expectedTools || [],
          [],
        );

        return c.json({ success: false, ...failedResult });
      }
    } catch (err) {
      const errorMessage = (err as Error)?.message || "Unknown error";
      return c.json({ success: false, error: errorMessage }, 500);
    }
  });

  tests.post("/cleanup", async (c) => {
    if (connectionManager) {
      try {
        await cleanupConnections(connectionManager, connectedServers);
        connectionManager = null;
        return c.json({ success: true });
      } catch (err) {
        const errorMessage = (err as Error)?.message || "Unknown error";
        return c.json({ success: false, error: errorMessage }, 500);
      }
    }
    return c.json({ success: true });
  });

  return tests;
}
