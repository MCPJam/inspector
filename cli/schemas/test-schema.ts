import { z } from "zod";

export const ModelSchema = z.object({
  id: z.string(),
  provider: z.enum(["openai", "anthropic", "deepseek", "ollama"]),
});

export const AdvancedConfigSchema = z.object({
  instructions: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxSteps: z.number().positive().optional(),
  toolChoice: z.enum(["auto", "required", "none"]).optional(),
});

export const TestSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  expectedTools: z.array(z.string()),
  model: ModelSchema,
  selectedServers: z.array(z.string()),
  advancedConfig: AdvancedConfigSchema.optional(),
});

export const TestsFileSchema = z.object({
  tests: z.array(TestSchema),
});

export type Model = z.infer<typeof ModelSchema>;
export type AdvancedConfig = z.infer<typeof AdvancedConfigSchema>;
export type Test = z.infer<typeof TestSchema>;
export type TestsFile = z.infer<typeof TestsFileSchema>;
