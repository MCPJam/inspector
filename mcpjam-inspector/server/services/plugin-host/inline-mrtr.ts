import { validateInputRequests, type MrtrInputCollector } from "@mcpjam/sdk";
import { openAILegacyFormSchemas } from "../../../shared/plugin-extensions/wire.js";
import { ownedPluginFormSchema } from "./owned-mrtr.js";

/** Keep the original host-tool call pending while its owned form is answered. */
export function createInlineMrtrCollector(
  serverId: string,
  answer: (request: { params?: Record<string, unknown> }) => Promise<unknown>,
): MrtrInputCollector {
  return async ({ inputRequests, signal }) => {
    validateInputRequests(inputRequests, ["form"]);
    const requests = Object.entries(inputRequests).map(
      ([key, input]) =>
        [
          key,
          openAILegacyFormSchemas.params.parse({
            ...input.params,
            mode: "form",
            requestedSchema: ownedPluginFormSchema(input.params, serverId),
          }),
        ] as const,
    );
    const responses: Record<
      string,
      ReturnType<typeof openAILegacyFormSchemas.result.parse>
    > = Object.create(null);
    for (const [key, params] of requests) {
      signal?.throwIfAborted();
      responses[key] = openAILegacyFormSchemas.result.parse(
        await answer({ params }),
      );
      signal?.throwIfAborted();
    }
    return responses;
  };
}
