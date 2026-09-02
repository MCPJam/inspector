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
  convexGetEnvironmentSecretSelection,
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
  | { name: string; reason: "misbound"; hosts: string[] }
  /**
   * A brokered row exists and binds correctly, but this run's ENVIRONMENT does
   * not grant it — either because the environment does not select it, or
   * because the turn resolved no environment at all. Distinct from `absent`
   * because the fix is a selection, not a new secret.
   */
  | { name: string; reason: "unselected"; environmentMissing: boolean };

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
 * ENVIRONMENT SCOPE, NOT PROJECT SCOPE. The environment is the GRANT BOUNDARY,
 * and this is the whole reason the second read exists. The authoritative
 * question — "which brokered secrets is THIS box carrying" — is
 * `projectSecretsEgress:listBrokeredSecretsForBox`, an `internalQuery` with no
 * public counterpart, but its body is reproducible from two public reads: it
 * resolves the box's grant to an `environmentId`, takes that environment's
 * `secretSelection.secretIds`, and keeps the brokered rows among them that
 * carry a complete binding. `projectSecrets:listSecrets` supplies the rows and
 * their bindings; `projectEnvironments:getEnvironment` supplies the selection.
 *
 * A project-wide answer would be WRONG, not merely imprecise: a correctly bound
 * brokered `CURSOR_API_KEY` that the run's environment does not select is never
 * composed into the box's egress transform, so reporting it available starts a
 * turn that provisions a box and then fails vendor auth with a placeholder.
 * Refusing before provisioning, naming the selection as the fix, is the point.
 *
 * The ONE rule this pair cannot reproduce is `isSecretDeliverable`'s live
 * personal-secret check against the session owner — and it does not have to.
 * Both reads run on the END USER's own bearer, and the backend filters both
 * through `canSeeSecret` / `visibleSecretIdsFor`, so a personal secret owned by
 * someone else is already absent from what we see. The residue is a turn whose
 * session owner is not the bearer's user, which the harness path does not
 * produce.
 */
export type BrokeredCredentialAvailability = {
  /** Names whose brokered row exists, binds what the runtime needs, AND is
   *  selected into this run's environment. */
  available: Set<string>;
  /** Names whose brokered row exists and IS granted but binds the wrong
   *  hosts/header — kept so the refusal can say WHICH hosts it found instead of
   *  "missing". */
  misboundHosts: Record<string, string[]>;
  /** Names whose brokered row exists and binds correctly but is NOT selected
   *  into this run's environment. The fix is a selection, not a new secret, so
   *  the refusal has to be able to say which. */
  unselected: Set<string>;
  /** This turn resolved NO Project Environment, so nothing is granted at all.
   *  Sharpens the `unselected` copy — "there is no environment" and "the
   *  environment does not select it" are different fixes. */
  environmentMissing: boolean;
};

export async function fetchBrokeredCredentialNames(args: {
  bearer?: string;
  projectId?: string;
  /**
   * The Project Environment this turn resolved — the GRANT BOUNDARY. Absent ⇒
   * the environment grants nothing (the backend's own rule: `resolveGrantForSandbox`
   * answers `[]` when it cannot resolve one), which is reported as `unselected`
   * with `environmentMissing`, never as an available credential.
   */
  environmentId?: string;
  /** Which box the turn runs on. Only `sandbox` (an ephemeral `evalSandboxes`
   *  row) can carry brokered secret transforms. */
  boxKind: "sandbox" | "computer";
  /** The credential names worth asking about, with the binding each needs. */
  required: Readonly<Record<string, HarnessExternalAccountBrokerBinding>>;
}): Promise<BrokeredCredentialAvailability | null> {
  const empty: BrokeredCredentialAvailability = {
    available: new Set(),
    misboundHosts: {},
    unselected: new Set(),
    environmentMissing: false,
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
  const candidates = rows.filter(
    (row) => row.delivery === "brokered" && args.required[row.name],
  );
  // Nothing to scope: skip the environment read entirely rather than pay a
  // round trip to narrow an empty set. A project with no brokered row for this
  // credential gets the same "add it" refusal it got before, one query later.
  if (candidates.length === 0) return empty;

  // The GRANT BOUNDARY. An absent environment is not an unknown — it is the
  // backend answering "no grant" — so it is recorded rather than refused as a
  // read failure, and the copy says which of the two it was.
  const environmentMissing = !args.environmentId;
  let selectedIds: ReadonlySet<string> = new Set<string>();
  if (args.environmentId) {
    try {
      selectedIds = new Set(
        await convexGetEnvironmentSecretSelection(args.bearer, {
          projectId: args.projectId,
          environmentId: args.environmentId,
        }),
      );
    } catch (error) {
      logger.warn(
        "[external-account-credentials] environment secret-selection lookup " +
          "failed; treating the credential as unestablished",
        { error: error instanceof Error ? error.message : String(error) },
      );
      return null;
    }
  }

  const available = new Set<string>();
  const misboundHosts: Record<string, string[]> = {};
  const unselected = new Set<string>();
  for (const row of candidates) {
    const required = args.required[row.name]!;
    // SELECTION FIRST. An unselected row's binding is irrelevant — it is not
    // composed onto the box either way — and reporting it as "misbound" would
    // send the reader to re-bind a secret whose binding is fine.
    if (!selectedIds.has(row.secretId)) {
      unselected.add(row.name);
      continue;
    }
    if (bindingDelivers(row, required)) {
      available.add(row.name);
      continue;
    }
    misboundHosts[row.name] = row.brokerHosts ?? [];
  }
  // A correctly bound, granted row supersedes every sibling that is not: the
  // credential WILL be delivered, so a stale note about another row must not
  // turn into a refusal for a project that is configured correctly.
  for (const name of available) {
    delete misboundHosts[name];
    unselected.delete(name);
  }
  // A row that is granted but misbound is the sharper complaint: it says the
  // binding is wrong rather than that the secret is not granted.
  for (const name of Object.keys(misboundHosts)) unselected.delete(name);
  return { available, misboundHosts, unselected, environmentMissing };
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
  /** Brokered rows that exist and bind correctly but this run's environment
   *  does NOT grant — used only to sharpen the refusal. */
  unselected?: ReadonlySet<string>;
  /** True when the turn resolved no Project Environment at all. */
  environmentMissing?: boolean;
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
    if (hosts && hosts.length > 0) {
      unsatisfied.push({ name, reason: "misbound", hosts });
      continue;
    }
    if (args.unselected?.has(name)) {
      unsatisfied.push({
        name,
        reason: "unselected",
        environmentMissing: args.environmentMissing === true,
      });
      continue;
    }
    unsatisfied.push({ name, reason: "absent" });
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
  // GRANTED-BUT-NOT-SELECTED, and the refusal that closes the gap this module
  // used to have. The secret exists and is bound correctly; what is missing is
  // the environment's grant. "Add a CURSOR_API_KEY" would send the reader to
  // create a duplicate of the row they already have, and — worse — the previous
  // behaviour was not to refuse at all: the turn started, provisioned a box with
  // no transform on it, and failed vendor auth with a placeholder.
  const unselected = args.unsatisfied.filter(
    (entry): entry is Extract<UnsatisfiedName, { reason: "unselected" }> =>
      entry.reason === "unselected",
  );
  if (unselected.length > 0) {
    const entry = unselected[0]!;
    return entry.environmentMissing
      ? `The ${args.harnessDisplayName} harness found a brokered ` +
          `${entry.name} project secret, but this run resolved no Project ` +
          `Environment — an environment is the grant boundary for project ` +
          `secrets, so nothing is delivered to the box. Run this host from a ` +
          `Project Environment that selects ${entry.name}, or configure it ` +
          `with materialized delivery.`
      : `The ${args.harnessDisplayName} harness found a brokered ` +
          `${entry.name} project secret, but the environment this run uses ` +
          `does not select it — brokered secrets are delivered per ` +
          `environment, so the box would carry only a placeholder. Select ` +
          `${entry.name} into that environment's secrets, or configure it ` +
          `with materialized delivery.`;
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
