import { createTurnAuthorizationRenewal } from "./turn-authorization-renewal";
import {
  turnAuthorizationIdentity,
  turnAuthorizationPart,
} from "@/shared/turn-authorization";
import type { z } from "zod";
import type { pluginOperationRequest } from "@/shared/plugin-operation-authorization";

type Operation = Omit<z.infer<typeof pluginOperationRequest>, "requestId">;
/** Only the original HTTP leg is kept authorized; no tool request is repeated here. */
export async function withPluginOperationAuthorization<T>(
  operation: Operation,
  signal: AbortSignal,
  renew: (
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>,
  send: (
    authorization?: z.infer<typeof turnAuthorizationIdentity>,
  ) => Promise<T>,
): Promise<T> {
  const requestId = crypto.randomUUID();
  const result = await renew(
    { operation: { ...operation, requestId } },
    signal,
  );
  if (result.operationAuthorization === undefined) return send();
  const metadata = turnAuthorizationPart.parse(result.operationAuthorization);
  if (
    !("pluginOperation" in metadata.data) ||
    metadata.data.requestId !== requestId ||
    metadata.data.pluginOperation.invocationId !== operation.invocationId
  )
    throw new Error("This app action is not authorized. Reopen the app and try the action again.");
  const {
    tokenExpiresAt: _tokenExpiry,
    expiresAt: _expiry,
    ...identity
  } = metadata.data;
  const renewal = createTurnAuthorizationRenewal(() => ({
    operationId: operation.invocationId,
    requestId,
  }));
  renewal.accept(metadata);
  try {
    signal.throwIfAborted();
    return await send(identity);
  } finally {
    renewal.stop();
    try {
      await renew({ cancelAuthorization: identity }, AbortSignal.timeout(3000));
    } catch {
      // The HTTP leg disposes its claim; an unclaimed preflight expires after 60s.
    }
  }
}
