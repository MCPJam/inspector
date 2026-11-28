/**
 * Pieces shared by the mock route's tests: a resolved mock as the backend
 * answers it, and a dialer that reaches the route the way a client does.
 */
import { MCPClientManager } from "@mcpjam/sdk";
import type { ResolvedMock } from "../backend.js";

export function resolvedMock(overrides: Partial<ResolvedMock> = {}): ResolvedMock {
  return {
    mockId: "mock1",
    projectId: "proj1",
    name: "Echo mock",
    version: 2,
    headVersion: 2,
    contentHash: "a".repeat(64),
    definition: {
      tools: {
        greet: {
          description: "Greets",
          inputSchema: { type: "object", properties: { who: { type: "string" } } },
          answer: {
            from: "saved",
            cases: [{ result: { content: [{ type: "text", text: "hello" }] } }],
          },
        },
      },
    },
    baseServerId: null,
    ...overrides,
  };
}

/** Connects a client to whatever `serve` answers, as a dialer's `baseFetch` does. */
export async function dialMock(
  serve: (request: Request) => Promise<Response>,
): Promise<MCPClientManager> {
  const manager = new MCPClientManager();
  await manager.connectToServer("mock", {
    url: "https://mock.test/mock1",
    baseFetch: ((input: string, init?: RequestInit) =>
      serve(new Request(input, init))) as typeof fetch,
  });
  return manager;
}
