/**
 * The credential an EXTERNAL-ACCOUNT harness (Cursor) runs under, declared once
 * for the server runtime registry and every client surface, and the one
 * function that turns "this client runs Cursor" into the secret grant its
 * environment must carry.
 *
 * Why a grant at all: the customer's `CURSOR_API_KEY` is a project secret
 * delivered to the box by brokered egress, and a project secret reaches a box
 * only through its ENVIRONMENT's `secretSelection`. A Cursor cell composed
 * without one runs with no key on its box, and — unlike Claude Code and Codex —
 * there is no model lease to rescue it later. So every surface that composes an
 * environment for a Cursor client (the evals/swarms composer, User Testing, the
 * Playground's hidden environment) asks THIS function what the cell must carry,
 * and a missing key is an error at composition time, never a refusal one turn
 * into a run.
 *
 * Pure and dependency-free: the registry (server), the composer (client) and
 * the tests all import it.
 */

/** What a harness needs from the project's secrets. */
export interface ExternalAccountCredentialSpec {
  /** The env-var name the CLI reads — and the project secret's name. */
  readonly env: string;
  /** What a person calls it, for messages. */
  readonly label: string;
  /**
   * The egress binding a BROKERED secret of this name must carry for the key to
   * reach the vendor. Lowercase header and exact hosts: the backend canonicalizes
   * stored rows that way, so this is what a saved secret compares equal to.
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
export const EXTERNAL_ACCOUNT_CREDENTIALS = {
  cursor: {
    env: "CURSOR_API_KEY",
    label: "Cursor API key",
    binding: {
      hosts: ["api2.cursor.sh"],
      header: "authorization",
      template: "Bearer {}",
    },
  },
} as const satisfies Record<string, ExternalAccountCredentialSpec>;

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

/** The slice of a project secret's metadata this decision reads. */
export interface ExternalCredentialSecret {
  secretId: string;
  name: string;
  delivery: "brokered" | "materialized";
  sharing: "user" | "project";
  brokerHosts?: readonly string[];
  brokerHeader?: string;
  brokerTemplate?: string;
}

export type ExternalCredentialProblem =
  /** No brokered secret of that name is visible to the composer. */
  | "absent"
  /** One exists but its binding cannot deliver this credential. */
  | "misbound"
  /** A usable one exists but is personal, and this surface needs a shared one. */
  | "not_shared"
  /** The project's secrets could not be read, so nothing can be established. */
  | "unavailable";

/** The key is missing or unusable. `message` is written for the person who must fix it. */
export class ExternalCredentialMissingError extends Error {
  readonly code: ExternalCredentialProblem;
  readonly harnessId: string;
  readonly credentialName: string;
  constructor(
    code: ExternalCredentialProblem,
    harnessId: string,
    credentialName: string,
    message: string,
  ) {
    super(message);
    this.name = "ExternalCredentialMissingError";
    this.code = code;
    this.harnessId = harnessId;
    this.credentialName = credentialName;
  }
}

/** Does this secret's binding actually deliver the credential? (Same rule the server's pre-flight applies.) */
export function bindingDeliversCredential(
  secret: Pick<
    ExternalCredentialSecret,
    "brokerHosts" | "brokerHeader" | "brokerTemplate"
  >,
  spec: ExternalAccountCredentialSpec,
): boolean {
  if (
    !secret.brokerHosts?.length ||
    !secret.brokerHeader ||
    !secret.brokerTemplate
  ) {
    return false;
  }
  if (secret.brokerHeader.toLowerCase() !== spec.binding.header.toLowerCase()) {
    return false;
  }
  if (!secret.brokerTemplate.includes("{}")) return false;
  const hosts = new Set(secret.brokerHosts.map((host) => host.toLowerCase()));
  return spec.binding.hosts.every((host) => hosts.has(host.toLowerCase()));
}

export interface ExternalCredentialSelection {
  mode: "explicit";
  secretIds: string[];
}

/**
 * The secret grant a client of this harness must carry — or `undefined` when
 * the harness needs no external credential. THROWS when it needs one and the
 * project has no usable key, so a Cursor cell is never composed without it.
 *
 * `secrets` is the composer's own view (project-shared rows plus their own
 * personal ones; another member's personal key is invisible to them). Brokered
 * only: a materialized `CURSOR_API_KEY` cannot be delivered to a hosted box.
 * Only the composer's own (personal) key is selected; a project-shared one is
 * refused — see the comment where it is handled.
 *
 * `requireShared` is for a surface whose participants are not the composer —
 * User Testing — which therefore cannot carry a personal key at all.
 */
export function externalCredentialSecretSelection(
  hostConfig: { harness?: string | null },
  secrets: readonly ExternalCredentialSecret[] | undefined,
  options: { requireShared?: boolean } = {},
): ExternalCredentialSelection | undefined {
  const harnessId = hostConfig.harness ?? undefined;
  const spec = externalAccountCredentialFor(harnessId);
  if (!spec || !harnessId) return undefined;
  const fail = (code: ExternalCredentialProblem, message: string): never => {
    throw new ExternalCredentialMissingError(
      code,
      harnessId,
      spec.env,
      message,
    );
  };
  if (secrets === undefined) {
    return fail(
      "unavailable",
      `Couldn't read this project's secrets to find the ${spec.label}. Try again in a moment.`,
    );
  }
  const named = secrets.filter(
    (secret) => secret.name === spec.env && secret.delivery === "brokered",
  );
  const usable = named.filter((secret) =>
    bindingDeliversCredential(secret, spec),
  );
  // Only the composer's OWN key is ever selected. A project-shared key is
  // never auto-selected: the harness's shell is unrestricted and the egress
  // proxy rewrites the credential header on the vendor's host, so anyone who
  // can run the harness can have it exchange the key for a reusable vendor
  // token (Cursor: `/auth/exchange_user_api_key`) and read it back. A brokered
  // key keeps the raw value out of the box, not the access it grants — so
  // sharing it project-wide would hand every member that access.
  const personal = usable.find((secret) => secret.sharing === "user");
  if (personal) {
    if (options.requireShared) {
      return fail(
        "not_shared",
        `${spec.label} can't run in User Testing: it signs in with a personal account, and nobody else may use yours.`,
      );
    }
    return { mode: "explicit", secretIds: [personal.secretId] };
  }
  if (usable.some((secret) => secret.sharing === "project")) {
    return fail(
      "not_shared",
      `${spec.env} is shared with the project, which Cursor doesn't use: the agent could read a reusable token back from it. Add your own ${spec.label} instead.`,
    );
  }
  if (named.length > 0) {
    return fail(
      "misbound",
      `${spec.env} exists but isn't set up to reach Cursor. It must be a brokered secret for ${spec.binding.hosts.join(
        ", ",
      )} with header "${spec.binding.header}" and template "${
        spec.binding.template
      }".`,
    );
  }
  return fail(
    "absent",
    `Add your ${spec.label} (${spec.env}) before using Cursor: this client signs in with your own Cursor account.`,
  );
}

/**
 * What a client-creation form must do about the key a client of this harness
 * signs in with.
 *
 *  - `none`     — the harness needs no key, or the creator already has a usable
 *                 one of their own.
 *  - `loading`  — the secrets have not loaded yet. Creating now would skip the
 *                 key step on a guess, so the form waits.
 *  - `needed`   — the creator must paste their key. `replaceSecretId` names
 *                 their OWN existing row of that name (mis-bound, or
 *                 materialized), which the form updates in place: a personal
 *                 name is unique per owner, so creating a second one would fail.
 */
export type ExternalKeySetup =
  | { state: "none" }
  | { state: "loading" }
  | { state: "needed"; replaceSecretId?: string };

export function externalKeySetupFor(
  harness: string | null | undefined,
  secrets: readonly ExternalCredentialSecret[] | undefined,
): ExternalKeySetup {
  const spec = externalAccountCredentialFor(harness ?? undefined);
  if (!spec) return { state: "none" };
  if (secrets === undefined) return { state: "loading" };
  try {
    externalCredentialSecretSelection({ harness }, secrets);
    return { state: "none" };
  } catch (error) {
    if (!(error instanceof ExternalCredentialMissingError)) throw error;
  }
  const own = secrets.find(
    (secret) => secret.name === spec.env && secret.sharing === "user",
  );
  return own
    ? { state: "needed", replaceSecretId: own.secretId }
    : { state: "needed" };
}
