// server/src/testing/types.ts
import { ServerConfig } from "../shared/types.js";

export interface TestCase {
  id: string;
  name: string;
  prompt: string;
  expectedTools?: string[];
  serverConfigs: ServerConfig[];
  judgeConfig?: JudgeConfig;
  timeout?: number;
  metadata?: Record<string, any>;
}

export interface TestResult {
  id: string;
  testCase: TestCase;
  toolCalls: ToolCallRecord[];
  verdict?: JudgeVerdict;
  duration: number;
  success: boolean;
  error?: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface ToolCallRecord {
  toolName: string;
  serverId: string;
  serverName: string;
  parameters: Record<string, any>;
  response: any;
  executionTimeMs: number;
  success: boolean;
  error?: string;
  timestamp: Date;
}

export interface JudgeConfig {
  provider: "openai" | "anthropic" | "ollama";
  model: string;
  temperature: number;
  maxTokens: number;
  apiKey: string;
  baseUrl?: string;
}

export interface JudgeVerdict {
  passed: boolean;
  confidence: number;
  reasoning: string;
  toolAccuracy: number;
  suggestions?: string;
}

export interface TestServerConfig {
  port: number;
  host: string;
  cors: boolean;
  rateLimiting: boolean;
  database: DatabaseConfig;
  logging: LoggingConfig;
}

export interface DatabaseConfig {
  url: string;
  maxConnections: number;
  timeout: number;
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  format: "json" | "text";
  outputs: string[];
}
