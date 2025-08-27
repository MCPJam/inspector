import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { MCPClient, MastraMCPServerDefinition } from "@mastra/mcp";
import { Agent } from "@mastra/core/agent";
import { access } from "fs/promises";
import { which } from "which";
import path from "path";
import { EnvironmentFile, EnvironmentFileSchema, TestsFile, TestsFileSchema, substituteEnvVariables } from "./config-schema";
import { generateJUnitXML, TestRunResult } from "./junit-reporter";
import { validateMultipleServerConfigs, createMCPClientWithMultipleConnections } from "./mcp-utils";

export type RunnerOptions = {
  tests: TestsFile;
  environment: EnvironmentFile;
  workspaceRoot: string;
  defaults?: {
    concurrency?: number; // default 4, capped at 8
    timeoutMs?: number; // default 30000
    maxSteps?: number; // default 10
  };
};

function assertNoOllama(tests: TestsFile) {
  for (const t of tests.tests) {
    if ((t.model as any)?.provider === "ollama") {
      throw new Error("Provider 'ollama' is not supported in MVP");
    }
  }
}

async function resolveCommand(cmd: string): Promise<string> {
  try {
    // If already absolute path, verify access
    if (path.isAbsolute(cmd)) {
      await access(cmd);
      return cmd;
    }
    // Use which for commands like "python"
    const abs = await which(cmd);
    return abs;
  } catch {
    throw new Error(`Command not found or not executable: ${cmd}`);
  }
}

function assertUniqueToolNames(serverToolsets: Record<string, any>) {
  const seen = new Set<string>();
  for (const [toolName] of Object.entries(serverToolsets)) {
    if (seen.has(toolName)) {
      throw new Error(`Duplicate tool name detected across servers: ${toolName}`);
    }
    seen.add(toolName);
  }
}

function createModel(model: { id: string; provider: string }, providerApiKeys: EnvironmentFile["providerApiKeys"]) {
  switch (model.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: providerApiKeys.anthropic || process.env.ANTHROPIC_API_KEY || "" })(model.id);
    case "openai":
      return createOpenAI({ apiKey: providerApiKeys.openai || process.env.OPENAI_API_KEY || "" })(model.id);
    case "deepseek":
      return createOpenAI({ apiKey: providerApiKeys.deepseek || process.env.DEEPSEEK_API_KEY || "", baseURL: "https://api.deepseek.com/v1" })(model.id);
    default:
      throw new Error(`Unsupported provider: ${model.provider}`);
  }
}

export type RunAllOutcome = {
  results: TestRunResult[];
  passed: boolean;
};

export async function runAll({ tests, environment, workspaceRoot, defaults }: RunnerOptions): Promise<RunAllOutcome> {
  assertNoOllama(tests);

  const concurrency = Math.max(1, Math.min(8, defaults?.concurrency ?? 4));
  const defaultTimeoutMs = defaults?.timeoutMs ?? 30000;
  const defaultMaxSteps = defaults?.maxSteps ?? 10;

  // Prepare servers: resolve stdio command paths and script paths
  const preparedServers: Record<string, MastraMCPServerDefinition> = {};
  for (const [name, def] of Object.entries(environment.mcpServers)) {
    if ((def as any).command) {
      const std = def as any;
      const resolvedCmd = await resolveCommand(std.command);
      const args = Array.isArray(std.args) ? std.args.map((a: string) => (a.startsWith("./") || a.startsWith("../") ? path.resolve(workspaceRoot, a) : a)) : undefined;
      preparedServers[name] = {
        command: resolvedCmd,
        args,
        env: std.env,
      } as any;
    } else if ((def as any).url) {
      const http = def as any;
      preparedServers[name] = {
        url: new URL(http.url),
        requestInit: http.headers ? { headers: http.headers } : undefined,
      } as any;
    }
  }

  const results: TestRunResult[] = [];
  let failed = false;

  let active = 0;
  let index = 0;

  const runNext = async (): Promise<void> => {
    if (index >= tests.tests.length) return;
    const test = tests.tests[index++];
    active++;
    try {
      const calledTools = new Set<string>();
      const expectedSet = new Set<string>(test.expectedTools || []);
      const selectedNames = test.selectedServers && test.selectedServers.length > 0 ? test.selectedServers : Object.keys(preparedServers);

      const serverConfigs: Record<string, MastraMCPServerDefinition> = {};
      for (const n of selectedNames) if (preparedServers[n]) serverConfigs[n] = preparedServers[n];

      const validation = validateMultipleServerConfigs(serverConfigs);
      let finalServers: Record<string, MastraMCPServerDefinition> = {};
      if (validation.success && validation.validConfigs) finalServers = validation.validConfigs;
      else if (validation.validConfigs && Object.keys(validation.validConfigs).length > 0) finalServers = validation.validConfigs;
      else throw new Error("No valid MCP server configs for test");

      const client = createMCPClientWithMultipleConnections(finalServers);
      const model = createModel(test.model as any, environment.providerApiKeys || {});

      const agent = new Agent({
        name: `TestAgent-${test.title}`,
        instructions: test.advancedConfig?.instructions || "You are a helpful assistant with access to MCP tools",
        model,
      });

      const toolsets = await client.getToolsets();

      // Optional validation: ensure unique tool names across servers
      // Note: toolsets is a map of tool name -> tool definition
      assertUniqueToolNames(toolsets);

      const start = Date.now();
      const timeoutMs = test.advancedConfig?.timeout ?? defaultTimeoutMs;
      const maxSteps = test.advancedConfig?.maxSteps ?? defaultMaxSteps;

      let errorMessage: string | undefined;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const stream = await agent.stream([{ role: "user", content: test.prompt } as any], {
            maxSteps,
            toolsets,
            signal: controller.signal,
            onStepFinish: ({ toolCalls }) => {
              (toolCalls || []).forEach((c: any) => {
                const toolName = c?.name || c?.toolName;
                if (toolName) calledTools.add(toolName);
              });
            },
          });
          for await (const _ of stream.textStream) {
            // drain
          }
        } finally {
          clearTimeout(timeout);
        }
      } catch (err: any) {
        errorMessage = err?.message || String(err);
      }

      const called = Array.from(calledTools);
      const missing = Array.from(expectedSet).filter((t) => !calledTools.has(t));
      const unexpected = called.filter((t) => !expectedSet.has(t));
      const passed = (!test.expectedTools || test.expectedTools.length === 0)
        ? called.length === 0 && !errorMessage
        : missing.length === 0 && unexpected.length === 0 && !errorMessage;

      if (!passed) failed = true;
      const durationMs = Date.now() - start;
      results.push({
        title: test.title,
        passed,
        durationMs,
        summary: { calledTools: called, missingTools: missing, unexpectedTools: unexpected, error: errorMessage },
      });

      try { await client.disconnect(); } catch {}
    } catch (err: any) {
      failed = true;
      results.push({
        title: tests.tests[index - 1].title,
        passed: false,
        durationMs: 0,
        summary: { calledTools: [], missingTools: [], unexpectedTools: [], error: err?.message || String(err) },
      });
    } finally {
      active--;
      if (index < tests.tests.length) await runNext();
    }
  };

  const starters = Math.min(concurrency, tests.tests.length);
  const startersPromises: Promise<void>[] = [];
  for (let i = 0; i < starters; i++) startersPromises.push(runNext());
  await Promise.all(startersPromises);

  return { results, passed: !failed };
}

export async function loadAndValidateFiles(testsJson: unknown, envJson: unknown): Promise<{ tests: TestsFile; environment: EnvironmentFile }> {
  // Substitution occurs prior to validation
  const testsSub = substituteEnvVariables(testsJson as any);
  const envSub = substituteEnvVariables(envJson as any);

  const missing = [...testsSub.missingKeys, ...envSub.missingKeys];
  if (missing.length > 0) {
    const unique = Array.from(new Set(missing));
    throw new Error(`Missing environment variables: ${unique.join(", ")}`);
  }

  const tests = TestsFileSchema.parse(testsSub.value);
  const environment = EnvironmentFileSchema.parse(envSub.value);

  // Validate constraints not covered by schema
  // - Reject provider ollama in tests
  assertNoOllama(tests);

  // - Validate HTTP headers presence if needed (no-op in MVP)

  return { tests, environment };
}

export function formatJUnit(results: TestRunResult[]): string {
  return generateJUnitXML({ suiteName: "MCPJAM Tests", results });
}

