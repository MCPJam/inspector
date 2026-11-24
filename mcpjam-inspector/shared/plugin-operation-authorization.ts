import { z } from "zod";
import { turnAuthorizationIdentity } from "./turn-authorization.js";

export const pluginOperationRequest = z
  .object({
    requestId: z.string().uuid(),
    invocationId: z.string().uuid(),
    kind: z.enum(["call", "activation"]),
    params: z
      .object({
        name: z.string().min(1).max(256),
        arguments: z.record(z.string(), z.unknown()).optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => (value.kind === "call") === (value.params !== undefined));
export const pluginOperationAuthorization = turnAuthorizationIdentity.refine(
  (value) => "pluginOperation" in value,
);
