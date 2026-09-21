import { z } from "zod";

/** Where an AI-assisted Markdown case was authored from; not an import claim. */
export const caseSourceSchema = z
  .object({
    format: z.literal("markdown"),
    method: z.literal("ai"),
    fileName: z.string().min(1).max(255),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
    excerpt: z
      .string()
      .min(1)
      .max(100 * 1024),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    extractorVersion: z.string().min(1).max(100),
  })
  .strict()
  .refine(
    (source) => source.endLine >= source.startLine,
    "Invalid source line range"
  );
export type CaseSource = z.infer<typeof caseSourceSchema>;
