import { z } from "zod";

export const AdvancedConfigSchema = z
  .object({
    instructions: z.string().optional(),
    temperature: z.number().optional(),
    maxSteps: z.number().int().min(1).optional(),
    toolChoice: z.string().optional(),
  })
  .passthrough(); // Allow additional fields

export const TestCaseSchema = z.object({
  title: z.string().min(1),
  query: z.string().min(1),
  runs: z.number().int().min(1),
  model: z.string().min(1),
  expectedToolCalls: z.array(z.string()),
  judgeRequirement: z.string().optional(),
  advancedConfig: AdvancedConfigSchema.optional(),
});

export type TestCase = z.infer<typeof TestCaseSchema>;

export function validateTestCase(value: unknown): TestCase[] {
  try {
    const result = z.array(TestCaseSchema).parse(value);
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(error.message);
    }
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}
