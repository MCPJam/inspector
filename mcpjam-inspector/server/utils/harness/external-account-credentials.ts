/**
 * The credential an EXTERNAL-ACCOUNT harness authenticates with, and the two
 * ways a project can supply it.
 *
 * A harness with `modelAccess: 'external-account'` (Cursor CLI) authenticates
 * on the CUSTOMER's own account with the runtime vendor. MCPJam mints no model
 * lease, so the only credential in play is the customer's — and a project can
 * hand it over in either of the two deliveries the secrets system already
 * supports:
 *
 *   MATERIALIZED — the plaintext is resolved by this process and handed to the
 *     adapter as its auth environment. The original behaviour, unchanged.
 *
 *   BROKERED (preferred) — the plaintext never enters this process OR the box.
 *     The backend composes the secret into the box's E2B egress transform,
 *     which overwrites the credential header on the way out of the VM; the box
 *     carries a placeholder so the CLI has something to send.
 *
 * ## Why brokered had to exist
 *
 * Hosted evals and swarms REFUSE an environment that selects a materialized
 * secret — `convex/evalSandboxes.ts` (`materialized_secrets_unsupported`) and
 * `convex/journeyRuns.ts` (`ENV_MATERIALIZED_SECRETS_UNSUPPORTED`) — because
 * only the CHAT path resolves and injects materialized values, so on a
 * runner-claimed attempt they would be silently ABSENT and the run would score
 * a healthy connector as broken. Both refusals say in as many words that
 * brokered secrets are fine there.
 *
 * With materialized as the only accepted delivery, `harness: "cursor"` could
 * therefore not run in a hosted eval or swarm AT ALL: configure the secret the
 * turn demands and the run is refused at sandbox reservation; leave it out and
 * the turn is refused for a missing credential. This module is the way out of
 * that vice.
 *
 * ## The placeholder contract, and where it is enforced
 *
 * There is no value-matching contract, and it matters that this is stated
 * rather than assumed. `composeBoxPolicy` in
 * `mcpjam-backend/convex/lib/harnessBrokerEgress.ts` builds
 * `transform[host][header] = <template with {} substituted>`, which
 * `convex/lib/computerProviders/e2b.ts` serialises as
 * `rules[host] = [{ transform: { headers } }]`. That injection is HOST-SCOPED
 * and UNCONDITIONAL: the proxy overwrites the header regardless of what the
 * box put in it. So the in-box value only has to be present — never guessable,
 * never correct — which is exactly what makes a fixed, obviously-fake
 * placeholder the right thing to send.
 *
 * (This is deliberately NOT the `@ai-sdk/harness` credential-brokering shape,
 * which matches on the outgoing header VALUE and therefore needs a random
 * per-session placeholder. That mechanism keeps the real key in the HOST
 * PROCESS; MCPJam's keeps it in the backend, behind KMS, which is strictly
 * stronger. See `e2b-sandbox-provider.ts` for why the two cannot be combined.)
 *
 * ## Fail-closed, in both directions
 *
 * Availability is a TRI-STATE and the third state is not "no". A metadata read
 * that fails answers `null` — "we could not establish that this credential is
 * brokered" — and a null is refused exactly like an absence. Guessing "yes"
 * would start a turn whose credential silently never arrives; guessing "no"
 * from a blip would refuse a correctly configured project. Refusing on
 * `null` is the same answer the turn gave before brokering existed, so a
 * degraded read is a non-regression rather than a new failure.
 */
import {
  convexListProjectSecretBindings,
  type ProjectSecretBinding,
} from "../computers/convex-secrets-client.js";
import { logger } from "../logger.js";
import type { HarnessExternalAccountBrokerBinding } from "./registry.js";

/** Placeholder credential value handed to the in-sandbox CLI when an
 *  EXTERNAL-ACCOUNT credential is delivered by a BROKERED project secret.
 *
 *  The real key never enters this process or the box: the backend composes the
 *  secret into the box's E2B egress transform, which OVERWRITES the credential
 *  header on the way out of the VM (`convex/lib/harnessBrokerEgress.ts` →
 *  `rules[host] = [{ transform: { headers } }]`). That injection is
 *  host-scoped and unconditional — it does not match on the outgoing value —
 *  so this placeholder only has to be PRESENT, never guessable, and never
 *  correct.
 *
 *  Deliberately a fixed, obviously-fake string rather than a random token:
 *  a random one would look like a credential in a log or a `ps` line, and
 *  there is nothing for it to be unguessable against. Same reasoning, and the
 *  same shape, as `BROKER_DUMMY_CREDENTIAL` in `registry.ts` — which the
 *  brokered MODEL path has handed the CLI since COMP-23.
 *
 *  Lives here rather than beside that one on purpose: this value is meaningful
 *  only to the delivery decision below, and the registry is mocked wholesale by
 *  the turn tests, so importing it from there would make a constant depend on a
 *  test double.
 *
 *  If the transform is NOT installed (a misconfigured binding, a box the
 *  backend does not compose secrets onto), this value reaches the vendor and
 *  is rejected as an invalid key — a loud 401 from the runtime, never a
 *  silently unauthenticated turn. */
export const EXTERNAL_ACCOUNT_BROKERED_PLACEHOLDER =
  "mcpjam-brokered-credential";

/** What a turn should hand the adapter, and what each name cost to get there. */
export type ExternalAccountCredentialPlan = {
  /** The adapter's auth environment: real values for materialized names,
   *  placeholders for brokered ones. */
  auth: Record<string, string>;
  /** Names satisfied by a MATERIALIZED secret. These are the ones the turn
   *  removes from the box's session env bag, and the only ones a delivery
   *  stamp may be recorded for — a brokered secret is delivered by the
   *  backend, and stamping it here would credit a delivery this process did
   *  not make. */
  materializedNames: string[];
  /** Names satisfied by a BROKERED secret. Present for logging and for the
   *  tests that pin which arm ran; nothing downstream branches on it. */
  brokeredNames: string[];
};

/** Why a name could not be satisfied — one arm per thing a user can fix. */
type UnsatisfiedName =
  /** Neither delivery is configured, or we could not establish that one is. */
  | { name: string; reason: "absent" }
  /** A brokered row exists but its binding cannot deliver this credential. */
  | { name: string; reason: "misbound"; hosts: string[] };

/**
 * Does a brokered row's binding actually deliver this credential?
 *
 * Checked rather than trusted because a brokered secret with the right NAME and
 * the wrong HOST is the one misconfiguration that would otherwise reach the
 * vendor as a placeholder and come back as an unexplained 401. The row is
 * canonicalized at write time (hosts lowercased, header lowercased), so this is
 * an exact comparison on both sides and not a normalization pass.
 *
 * The TEMPLATE is required to contain `{}` — that is where the backend
 * substitutes the plaintext — but its surrounding text is NOT compared. A
 * runtime that accepts `Bearer <key>` and a project that stored `bearer {}`
 * would be a false refusal, and the vendor, not MCPJam, is the authority on
 * what its own header may look like.
 */
function bindingDelivers(
  row: ProjectSecretBinding,
  required: HarnessExternalAccountBrokerBinding,
): boolean {
  if (!row.brokerHosts?.length || !row.brokerHeader || !row.brokerTemplate) {
    return false;
  }
  if (row.brokerHeader.toLowerCase() !== required.header.toLowerCase()) {
    return false;
  }
  if (!row.brokerTemplate.includes("{}")) return false;
  const hosts = new Set(row.brokerHosts.map((host) => host.toLowerCase()));
  return required.hosts.every((host) => hosts.has(host.toLowerCase()));
}

/**
 * The brokered credentials this box will actually be carrying, by name.
 *
 * `null` means "could not establish", NOT "none" — see the file header.
 *
 * ## Two narrowings that are not optimizations
 *
 * EPHEMERAL BOXES ONLY. `projectSecretsEgress.resolveBoxSecretGrant` returns
 * `NO_GRANT` for anything without a `sandboxRowId`, and
 * `listBrokeredSecretsForBox` returns `[]`: "PERSISTENT COMPUTERS receive no
 * secrets in v1, and that is a decision rather than a gap". So a chat turn on a
 * project computer has no brokered transform on its box no matter what the
 * project has configured, and answering anything but "none" for it would be a
 * turn that authenticates with a placeholder.
 *
 * PROJECT SCOPE, NOT ENVIRONMENT SCOPE, and this is the honest limitation of
 * doing it from here. The exact question — "which brokered secrets is THIS box
 * carrying" — is `projectSecretsEgress:listBrokeredSecretsForBox`, keyed on the
 * sandbox row, but it is an `internalQuery` with no public counterpart, and
 * `runHarnessTurn` is not even handed an `environmentId` to ask the
 * environment-scoped version with. The reachable read is
 * `projectSecrets:listSecrets`, which is project-scoped metadata.
 *
 * What that costs, precisely: a project that holds a correctly-bound brokered
 * `CURSOR_API_KEY` which is NOT selected into the run's environment is allowed
 * to start, and the runtime then fails its vendor auth. That is a legible
 * misconfiguration with a legible failure, and it is strictly better than the
 * alternative it replaces (the turn could not run at all). It is also the one
 * thing a names-only public query keyed on the box would fix outright — see the
 * note in `docs/inspector/claude-code-host.mdx`.
 */
export type BrokeredCredentialAvailability = {
  /** Names whose brokered row exists AND binds what the runtime needs. */
  available: Set<string>;
  /** Names whose brokered row exists but binds the wrong hosts/header — kept
   *  so the refusal can say WHICH hosts it found instead of "missing". */
  misboundHosts: Record<string, string[]>;
};

export async function fetchBrokeredCredentialNames(args: {
  bearer?: string;
  projectId?: string;
  /** Which box the turn runs on. Only `sandbox` (an ephemeral `evalSandboxes`
   *  row) can carry brokered secret transforms. */
  boxKind: "sandbox" | "computer";
  /** The credential names worth asking about, with the binding each needs. */
  required: Readonly<Record<string, HarnessExternalAccountBrokerBinding>>;
}): Promise<BrokeredCredentialAvailability | null> {
  const empty: BrokeredCredentialAvailability = {
    available: new Set(),
    misboundHosts: {},
  };
  if (Object.keys(args.required).length === 0) return empty;
  // Not a failure: this box provably carries no brokered transform, so "none"
  // is the correct answer rather than an unknown.
  if (args.boxKind !== "sandbox") return empty;
  if (!args.bearer || !args.projectId) return null;
  let rows: ProjectSecretBinding[];
  try {
    rows = await convexListProjectSecretBindings(args.bearer, {
      projectId: args.projectId,
    });
  } catch (error) {
    logger.warn(
      "[external-account-credentials] brokered secret lookup failed; " +
        "treating the credential as unestablished",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return null;
  }
  const available = new Set<string>();
  const misboundHosts: Record<string, string[]> = {};
  for (const row of rows) {
    if (row.delivery !== "brokered") continue;
    const required = args.required[row.name];
    if (!required) continue;
    if (bindingDelivers(row, required)) {
      available.add(row.name);
      // A correctly bound row supersedes a sibling that is not: the credential
      // WILL be delivered, so a stale "misbound" note must not turn into a
      // refusal for a project that is configured correctly.
      delete misboundHosts[row.name];
      continue;
    }
    if (!available.has(row.name)) {
      misboundHosts[row.name] = row.brokerHosts ?? [];
    }
  }
  return { available, misboundHosts };
}

/**
 * The hosts a brokered row for this credential must bind, as configured on the
 * adapter — quoted back in a refusal so the fix is the message.
 */
function requiredBindingSummary(
  binding: HarnessExternalAccountBrokerBinding,
): string {
  return `${binding.hosts.join(", ")} with header "${
    binding.header
  }" and template "${binding.template}"`;
}

/**
 * Decide, per credential name, which delivery satisfies it — or refuse.
 *
 * PURE: the reads happen above, so the decision can be tested without a
 * Convex double, and one call site cannot resolve a different answer from the
 * one it acts on.
 *
 * MATERIALIZED WINS when both are present. Not an arbitrary tiebreak: a
 * materialized value is the one this process can prove reached the box (the
 * env bag is built from it), and preferring the placeholder there would take a
 * working chat turn on a persistent computer and break it on the strength of a
 * row that box never receives.
 */
export function planExternalAccountCredentials(args: {
  /** For the refusal copy. */
  harnessDisplayName: string;
  required: readonly string[];
  /** The materialized project secrets this turn resolved, if any. */
  secretEnv: Readonly<Record<string, string>> | undefined;
  /** The adapter's brokered binding declaration, if it has one. */
  brokerBinding:
    | Readonly<Record<string, HarnessExternalAccountBrokerBinding>>
    | undefined;
  /** Names the box is carrying by brokered egress. `null` = could not tell,
   *  which is refused exactly like an absence. */
  brokeredAvailable: ReadonlySet<string> | null;
  /** Brokered rows that exist and match by NAME but not by BINDING — used only
   *  to sharpen the refusal. */
  misboundHosts?: Readonly<Record<string, string[]>>;
}): ExternalAccountCredentialPlan {
  const auth: Record<string, string> = {};
  const materializedNames: string[] = [];
  const brokeredNames: string[] = [];
  const unsatisfied: UnsatisfiedName[] = [];

  for (const name of args.required) {
    const materialized = args.secretEnv?.[name];
    if (materialized) {
      auth[name] = materialized;
      materializedNames.push(name);
      continue;
    }
    if (args.brokerBinding?.[name] && args.brokeredAvailable?.has(name)) {
      auth[name] = EXTERNAL_ACCOUNT_BROKERED_PLACEHOLDER;
      brokeredNames.push(name);
      continue;
    }
    const hosts = args.misboundHosts?.[name];
    unsatisfied.push(
      hosts && hosts.length > 0
        ? { name, reason: "misbound", hosts }
        : { name, reason: "absent" },
    );
  }

  if (unsatisfied.length > 0) {
    throw new Error(
      externalAccountCredentialRefusal({
        harnessDisplayName: args.harnessDisplayName,
        unsatisfied,
        brokerBinding: args.brokerBinding,
      }),
    );
  }
  return { auth, materializedNames, brokeredNames };
}

/**
 * Preflight-shaped refusal copy: names the variable, BOTH deliveries, and where
 * to set it, so the reader can act on it without opening a runbook.
 *
 * Naming both is the point of this change. The old copy said "requires a
 * CURSOR_API_KEY project secret", which is true and useless in a hosted eval:
 * the reader adds a materialized one and the RUN is then refused at sandbox
 * reservation for selecting a materialized secret, with no hint that the fix
 * was to have added a brokered one in the first place.
 */
function externalAccountCredentialRefusal(args: {
  harnessDisplayName: string;
  unsatisfied: readonly UnsatisfiedName[];
  brokerBinding:
    | Readonly<Record<string, HarnessExternalAccountBrokerBinding>>
    | undefined;
}): string {
  const misbound = args.unsatisfied.filter(
    (entry): entry is Extract<UnsatisfiedName, { reason: "misbound" }> =>
      entry.reason === "misbound",
  );
  if (misbound.length > 0) {
    const entry = misbound[0]!;
    const binding = args.brokerBinding?.[entry.name];
    return (
      `The ${args.harnessDisplayName} harness found a brokered ` +
      `${entry.name} project secret, but it is bound to ` +
      `${entry.hosts.join(", ")} — the runtime authenticates against ` +
      `${binding ? requiredBindingSummary(binding) : "a different host"}. ` +
      `Re-bind the secret under Project Settings → Secrets, or switch it to ` +
      `materialized delivery.`
    );
  }
  const names = args.unsatisfied.map((entry) => entry.name);
  const one = names.length === 1;
  const brokerable = names.filter((name) => args.brokerBinding?.[name]);
  const brokeredHint =
    brokerable.length > 0
      ? ` Use BROKERED delivery (bound to ` +
        `${requiredBindingSummary(args.brokerBinding![brokerable[0]!]!)}) if ` +
        `this environment is used by hosted evals or swarms — those refuse ` +
        `materialized secrets outright.`
      : "";
  return (
    `The ${args.harnessDisplayName} harness requires ${one ? "a " : ""}` +
    `${names.join(", ")} project ${one ? "secret" : "secrets"} in this ` +
    `environment, delivered either brokered or materialized — add ` +
    `${one ? "it" : "them"} under Project Settings → Secrets.${brokeredHint}`
  );
}
