import { z } from "zod";

// Provider IDs supported in MVP
export const ProviderIdSchema = z.enum(["anthropic", "openai", "deepseek"]);

export const ModelSchema = z.object({
  id: z.string().min(1),
  provider: ProviderIdSchema,
});

export const AdvancedConfigSchema = z
  .object({
    instructions: z.string().optional(),
    temperature: z.number().optional(),
    maxSteps: z.number().int().positive().optional(),
    toolChoice: z.string().optional(),
    timeout: z.number().int().positive().optional(),
  })
  .optional();

export const TestDefinitionSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  expectedTools: z.array(z.string().min(1)).optional(),
  model: ModelSchema,
  selectedServers: z.array(z.string().min(1)).optional(),
  advancedConfig: AdvancedConfigSchema,
});

export const TestsFileSchema = z.object({
  tests: z.array(TestDefinitionSchema).min(1),
});

// Environment schema
const HeadersSchema = z.record(z.string().min(1));

export const StdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

export const HttpServerSchema = z.object({
  url: z.string().url(),
  headers: HeadersSchema.optional(),
});

export const MCPServerSchema = z.union([StdioServerSchema, HttpServerSchema]);

export const EnvironmentFileSchema = z.object({
  mcpServers: z.record(MCPServerSchema),
  providerApiKeys: z
    .object({
      anthropic: z.string().optional(),
      openai: z.string().optional(),
      deepseek: z.string().optional(),
    })
    .default({}),
});

export type TestsFile = z.infer<typeof TestsFileSchema>;
export type TestDefinition = z.infer<typeof TestDefinitionSchema>;
export type EnvironmentFile = z.infer<typeof EnvironmentFileSchema>;
export type MCPServer = z.infer<typeof MCPServerSchema>;

// Environment variable substitution utilities
export type EnvSubstitutionResult<T> = {
  value: T;
  missingKeys: string[];
};

const ENV_PATTERN = /(?<!\\)\$\{([A-Z0-9_]+)\}/g;
const ESCAPED_PATTERN = /\\\$\{([A-Z0-9_]+)\}/g;

export function substituteEnvVariables<T>(input: T, env: NodeJS.ProcessEnv = process.env): EnvSubstitutionResult<T> {
  const missing: Set<string> = new Set();

  const recurse = (val: any): any => {
    if (typeof val === "string") {
      const replaced = val.replace(ENV_PATTERN, (_, key: string) => {
        const envVal = env[key];
        if (envVal === undefined) {
          missing.add(key);
          return "";
        }
        return envVal;
      });
      // Unescape \${VAR} -> ${VAR}
      return replaced.replace(ESCAPED_PATTERN, "${$1}");
    }
    if (Array.isArray(val)) {
      return val.map(recurse);
    }
    if (val && typeof val === "object") {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(val)) out[k] = recurse(v);
      return out;
    }
    return val;
  };

  const result = recurse(input);
  return { value: result, missingKeys: Array.from(missing) } as EnvSubstitutionResult<T>;
}

