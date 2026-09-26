/**
 * A connect the backend refused because of a saved credential — not because
 * the server is down or the user lacks access.
 *
 * Two cases, both answered with a 403 whose details say which:
 *
 * - `secretOriginMismatch`: the server's address moved to an origin its saved
 *   headers or client secret were not entered for. The fix is to re-enter
 *   them for the new address, so the server's configuration opens.
 * - `exportDenied`: the organization's credential export policy keeps saved
 *   credentials inside MCPJam-hosted connections, and this connect would have
 *   delivered them to this machine. Only an organization admin can change it.
 *
 * The decision is always the backend's. This module only recognises the
 * refusal on a connect result and turns it into something a person can act on.
 */

export type CredentialRefusal =
  | {
      kind: "origin_mismatch";
      boundOrigin: string | null;
      targetOrigin: string | null;
    }
  | { kind: "export_denied" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read a refusal off a connect result or an error's details. Local connect
 * envelopes carry the details top-level; hosted results carry them under
 * `credentialRefusal` (see `mcp-api.ts`).
 */
export function readCredentialRefusal(
  source: unknown,
): CredentialRefusal | null {
  const record = asRecord(source);
  if (!record) return null;
  const nested = asRecord(record.credentialRefusal);
  if (nested && typeof nested.kind === "string") {
    return readCredentialRefusal(
      nested.kind === "export_denied"
        ? { exportDenied: true }
        : {
            secretOriginMismatch: true,
            boundOrigin: nested.boundOrigin,
            targetOrigin: nested.targetOrigin,
          },
    );
  }
  if (record.secretOriginMismatch === true) {
    return {
      kind: "origin_mismatch",
      boundOrigin:
        typeof record.boundOrigin === "string" ? record.boundOrigin : null,
      targetOrigin:
        typeof record.targetOrigin === "string" ? record.targetOrigin : null,
    };
  }
  if (record.exportDenied === true) return { kind: "export_denied" };
  return null;
}

export function credentialRefusalMessage(
  refusal: CredentialRefusal,
  serverName?: string,
): string {
  const server = serverName ? `"${serverName}"` : "This server";
  if (refusal.kind === "export_denied") {
    return (
      `${server} uses saved credentials that your organization keeps inside ` +
      "MCPJam-hosted connections. Connect it from MCPJam in the browser, or " +
      "ask an organization admin to change the credential export policy."
    );
  }
  const moved =
    refusal.boundOrigin && refusal.targetOrigin
      ? ` Its saved credentials were entered for ${refusal.boundOrigin}, and it now points at ${refusal.targetOrigin}.`
      : " Its address changed after its credentials were saved.";
  return `${server} was not connected.${moved} Re-enter the credentials for the new address to connect.`;
}

type Listener = (serverName: string, refusal: CredentialRefusal) => void;
const listeners = new Set<Listener>();

/**
 * Ask whichever view owns the server list to open this server's
 * configuration. A no-op when nothing is listening (no servers view mounted);
 * the error message still says what to do.
 */
export function requestCredentialReentry(
  serverName: string,
  refusal: CredentialRefusal,
): void {
  for (const listener of listeners) listener(serverName, refusal);
}

export function onCredentialReentryRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Apply a refusal to a connect/reconnect result: the actionable message
 * replaces the raw one, and — for a moved server, which the person can fix —
 * its configuration is asked to open. Any other result passes through.
 */
export function withCredentialRefusal<T>(result: T, serverName?: string): T {
  const record = asRecord(result);
  if (!record || record.success === true) return result;
  const refusal = readCredentialRefusal(record);
  if (!refusal) return result;
  if (serverName && refusal.kind === "origin_mismatch") {
    requestCredentialReentry(serverName, refusal);
  }
  return {
    ...record,
    error: credentialRefusalMessage(refusal, serverName),
    credentialRefusal: refusal,
  } as T;
}
