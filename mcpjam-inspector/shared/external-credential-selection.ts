import { HARNESS_DESCRIPTORS } from "./harness-descriptors";
/**
 * The credential an EXTERNAL-ACCOUNT harness (Cursor) runs under, declared once
 * for the server runtime registry and every client surface.
 *
 * The key itself is the ORGANIZATION's, added by an org admin under
 * Organization → AI providers; the backend's egress injects it on the binding's
 * hosts, so no environment and no project secret carries it. What stays here is
 * what each surface needs to say about it: the name the CLI reads, what a
 * person calls it, and where egress puts it.
 *
 * Pure and dependency-free: the registry (server), the client and the tests
 * all import it.
 */

/** What a harness's account credential is called, and where it is injected. */
export interface ExternalAccountCredentialSpec {
  /** The env-var name the CLI reads. */
  readonly env: string;
  /** What a person calls it, for messages. */
  readonly label: string;
  /**
   * Where the backend's egress injects the key on the way to the vendor.
   * Lowercase header and exact hosts, as the backend stores bindings.
   */
  readonly binding: {
    readonly hosts: readonly string[];
    readonly header: string;
    readonly template: string;
  };
}

/**
 * Read off `@ai-sdk/harness-cursor`: it declares its own `credentialBrokering`
 * against `POST https://api2.cursor.sh/auth/exchange_user_api_key` carrying
 * `Authorization: Bearer <CURSOR_API_KEY>`. MCPJam's egress transform is
 * host-scoped, so brokering the host covers that exchange and any sibling call
 * that authenticates the same way.
 */
export const EXTERNAL_ACCOUNT_CREDENTIALS = { cursor: HARNESS_DESCRIPTORS.cursor.credential } as const satisfies Record<string, ExternalAccountCredentialSpec>;

/** The credential a harness authenticates with, or undefined when it needs none. */
export function externalAccountCredentialFor(
  harnessId: string | null | undefined,
): ExternalAccountCredentialSpec | undefined {
  if (!harnessId) return undefined;
  return Object.prototype.hasOwnProperty.call(
    EXTERNAL_ACCOUNT_CREDENTIALS,
    harnessId,
  )
    ? EXTERNAL_ACCOUNT_CREDENTIALS[
        harnessId as keyof typeof EXTERNAL_ACCOUNT_CREDENTIALS
      ]
    : undefined;
}
