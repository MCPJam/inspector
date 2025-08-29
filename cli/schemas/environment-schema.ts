import { z } from "zod";

export const MCPServerConfigSchema = z.union([
  // STDIO server
  z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
  // HTTP server
  z.object({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  }),
]);

export const EnvironmentFileSchema = z.object({
  mcpServers: z.record(MCPServerConfigSchema),
  providerApiKeys: z
    .object({
      anthropic: z.string().optional(),
      openai: z.string().optional(),
      deepseek: z.string().optional(),
    })
    .optional(),
});

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;
export type EnvironmentFile = z.infer<typeof EnvironmentFileSchema>;
