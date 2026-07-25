/**
 * A dual-era MRTR fixture: a modern (2026-07-28) server whose tool, prompt, and
 * resource each answer `input_required` on the first call and complete on the
 * retry that carries the accepted elicitation content (spec §12). Served via
 * `createMcpHandler` so it runs over the real modern wire (see
 * `mrtr-manager.integration.test.ts` for the HTTP harness).
 *
 * One tool (`confirm-typed`) declares an `outputSchema`, so the manager's
 * reconstructed tool output-schema validation on the MRTR path has something to
 * assert against.
 */

import { acceptedContent, createMcpHandler, inputRequired, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const MRTR_FIXTURE_INFO = {
  name: "mcpjam-mrtr-fixture",
  version: "1.0.0",
} as const;

export const MRTR_RESOURCE_URI = "test://mrtr/doc";

const answerSchema = {
  type: "object" as const,
  properties: { answer: { type: "string" as const } },
  required: ["answer"],
};

export function buildMrtrFixtureServer(): McpServer {
  const server = new McpServer(MRTR_FIXTURE_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
  });

  // Tool that requests input then echoes it back.
  server.registerTool(
    "confirm",
    {
      description: "Asks a question, then echoes the answer.",
      inputSchema: { topic: z.string() },
    },
    async ({ topic }, ctx) => {
      const answered = acceptedContent<{ answer: string }>(
        ctx.mcpReq.inputResponses,
        "q",
      );
      if (!answered) {
        return inputRequired({
          inputRequests: {
            q: inputRequired.elicit({
              message: `About ${topic}?`,
              requestedSchema: answerSchema,
            }),
          },
          requestState: "confirm-state-1",
        });
      }
      return {
        content: [{ type: "text" as const, text: `answer:${answered.answer}` }],
      };
    },
  );

  // Tool with an outputSchema, to exercise reconstructed output validation.
  server.registerTool(
    "confirm-typed",
    {
      description: "Asks a question, then returns structured content.",
      inputSchema: { topic: z.string() },
      outputSchema: { answer: z.string() },
    },
    async (_args, ctx) => {
      const answered = acceptedContent<{ answer: string }>(
        ctx.mcpReq.inputResponses,
        "q",
      );
      if (!answered) {
        return inputRequired({
          inputRequests: {
            q: inputRequired.elicit({
              message: "Typed answer?",
              requestedSchema: answerSchema,
            }),
          },
          requestState: "typed-state-1",
        });
      }
      return {
        content: [{ type: "text" as const, text: answered.answer }],
        structuredContent: { answer: answered.answer },
      };
    },
  );

  // Prompt that requests input then embeds it.
  server.registerPrompt(
    "confirm-prompt",
    {
      description: "A prompt that asks for input before rendering.",
      argsSchema: { topic: z.string() },
    },
    async (_args, ctx) => {
      const answered = acceptedContent<{ answer: string }>(
        ctx.mcpReq.inputResponses,
        "q",
      );
      if (!answered) {
        return inputRequired({
          inputRequests: {
            q: inputRequired.elicit({
              message: "Prompt answer?",
              requestedSchema: answerSchema,
            }),
          },
          requestState: "prompt-state-1",
        });
      }
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: `prompt:${answered.answer}` },
          },
        ],
      };
    },
  );

  // Resource that requests input then returns content.
  server.registerResource(
    "mrtr-doc",
    MRTR_RESOURCE_URI,
    { description: "A resource that asks for input before reading." },
    async (_uri, ctx) => {
      const answered = acceptedContent<{ answer: string }>(
        ctx.mcpReq.inputResponses,
        "q",
      );
      if (!answered) {
        return inputRequired({
          inputRequests: {
            q: inputRequired.elicit({
              message: "Resource answer?",
              requestedSchema: answerSchema,
            }),
          },
          requestState: "resource-state-1",
        });
      }
      return {
        contents: [
          {
            uri: MRTR_RESOURCE_URI,
            mimeType: "text/plain",
            text: `resource:${answered.answer}`,
          },
        ],
      };
    },
  );

  return server;
}

export function createMrtrFixtureHandler() {
  return createMcpHandler(buildMrtrFixtureServer);
}
