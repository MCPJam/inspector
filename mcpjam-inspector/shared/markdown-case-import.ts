import { z } from "zod";
import { caseSourceSchema } from "@mcpjam/sdk/contract";
export const MAX_MARKDOWN_BYTES = 100 * 1024;
export const importIssueSchema = z
  .object({
    code: z.enum([
      "missing_expectation",
      "missing_prerequisite",
      "unclear_expectation",
      "unsupported_workflow",
    ]),
    message: z.string().min(1).max(2000),
  })
  .strict();
export const markdownDraftSchema = z
  .object({
    draftId: z.string().min(1),
    title: z.string().max(500),
    prompt: z.string().max(20000),
    expectedOutput: z.string().max(10000).optional(),
    source: caseSourceSchema,
    issues: z.array(importIssueSchema).max(20),
  })
  .strict();
export const extractionResultSchema = z.object({
  ok: z.literal(true),
  drafts: z.array(markdownDraftSchema).max(50),
  warnings: z.array(z.string()).max(100),
});
export type MarkdownDraft = z.infer<typeof markdownDraftSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
export const markdownSaveSchema = z
  .object({
    projectId: z.string().min(1),
    suiteId: z.string().min(1),
    cases: z
      .array(
        z
          .object({
            caseId: z.string().min(1),
            idempotencyKey: z.string().min(1).max(200),
            title: z.string().trim().min(1).max(500),
            prompt: z.string().trim().min(1).max(20000),
            expectedOutput: z.string().trim().min(1).max(10000),
            source: caseSourceSchema,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type MarkdownSaveRequest = z.infer<typeof markdownSaveSchema>;
export type MarkdownSaveResult = {
  committed: Array<{
    index: number;
    title: string;
    testCaseId: string;
    replayed: boolean;
  }>;
  failed: Array<{ index: number; code: string; message: string }>;
};
