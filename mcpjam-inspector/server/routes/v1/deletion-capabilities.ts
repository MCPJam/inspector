import { z } from "zod";
import { makeFunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";

const capabilities = makeFunctionReference<"query">("deletionRequests:capabilities");
const schema = z.object({
  available: z.boolean(),
  protocolVersion: z.literal(1),
  scopeTypes: z.array(z.enum(["project", "organization"])),
});

export async function readDeletionCapabilities(client: ConvexHttpClient) {
  return schema.parse(await client.query(capabilities, {}));
}
