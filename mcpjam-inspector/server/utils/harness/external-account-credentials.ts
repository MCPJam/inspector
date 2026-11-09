/**
 * The credential an EXTERNAL-ACCOUNT harness (Cursor CLI) authenticates with:
 * the ORGANIZATION's own vendor key, added once by an org admin under
 * Organization → AI providers.
 *
 * MCPJam mints no model lease for such a harness, and the key never enters
 * this process or the box. The backend composes it into the box's E2B egress
 * transform, which overwrites the credential header on the way out of the VM;
 * the box carries a placeholder so the CLI has something to send.
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
 * box put in it. So the in-box value only has to be present, never guessable,
 * never correct, which is what makes a fixed, obviously-fake placeholder the
 * right thing to send.
 *
 * (This is deliberately NOT the `@ai-sdk/harness` credential-brokering shape,
 * which matches on the outgoing header VALUE and therefore needs a random
 * per-session placeholder. That mechanism keeps the real key in the HOST
 * PROCESS; MCPJam's keeps it in the backend, behind KMS, which is strictly
 * stronger. See `e2b-sandbox-provider.ts` for why the two cannot be combined.)
 *
 * ## Fail-closed
 *
 * Whether the key is ready is the backend's answer, asked before anything is
 * reserved. An answer that can't be read refuses the turn exactly like a
 * missing key: guessing "ready" would start a CLI whose credential never
 * arrives.
 */
import { ORG_KEY_MISSING_MESSAGE } from "@/shared/org-key-surfaces";
import { getHarnessCredentialReadiness } from "../computers/control-plane-client.js";
import { logger } from "../logger.js";

/** Placeholder credential value handed to the in-sandbox CLI. The org's key
 *  is injected over it by the box's egress transform (see the module note).
 *
 *  Deliberately a fixed, obviously-fake string rather than a random token:
 *  a random one would look like a credential in a log or a `ps` line, and
 *  there is nothing for it to be unguessable against. Same reasoning, and the
 *  same shape, as `BROKER_DUMMY_CREDENTIAL` in `registry.ts`, which the
 *  brokered MODEL path hands the CLI.
 *
 *  Lives here rather than beside that one on purpose: the registry is mocked
 *  wholesale by the turn tests, so importing it from there would make a
 *  constant depend on a test double.
 *
 *  If the transform is NOT installed, this value reaches the vendor and is
 *  rejected as an invalid key: a loud 401 from the runtime, never a silently
 *  unauthenticated turn. */
export const EXTERNAL_ACCOUNT_BROKERED_PLACEHOLDER =
  "mcpjam-brokered-credential";

/** The adapter's auth environment for an org-key turn: placeholders only. */
export type OrgKeyCredentialPlan = { auth: Record<string, string> };

const ORG_KEY_READINESS_TIMEOUT_MS = 10_000;

/**
 * A credential the turn cannot run without. Its own type so a caller that only
 * wants the refusal sentence (the Playground pre-flight) can tell it from an
 * unexpected failure, which must stay a server fault.
 */
export class ExternalAccountCredentialRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalAccountCredentialRefusal";
  }
}

/**
 * The credential an external-account harness turn (Cursor) runs on: the
 * organization's own key. Asked of the backend before anything is reserved,
 * so a turn with no key stops before any box starts. Undefined for a harness
 * that needs no external credential; THROWS the sentence the member reads
 * otherwise, including when readiness can't be read (never guessed ready).
 */
export async function resolveOrgKeyCredentialPlan(args: {
  harness: {
    id: string;
    modelAccess: string;
    externalAccountCredentialEnv?: readonly string[];
  };
  bearer?: string;
  projectId?: string;
  signal?: AbortSignal;
}): Promise<OrgKeyCredentialPlan | undefined> {
  const required =
    args.harness.modelAccess === "external-account"
      ? args.harness.externalAccountCredentialEnv
      : undefined;
  if (!required) return undefined;
  const timeout = AbortSignal.timeout(ORG_KEY_READINESS_TIMEOUT_MS);
  const answer =
    args.bearer && args.projectId
      ? await getHarnessCredentialReadiness({
          bearer: args.bearer,
          projectId: args.projectId,
          harnessId: args.harness.id,
          signal: args.signal ? AbortSignal.any([args.signal, timeout]) : timeout,
        })
      : null;
  if (!answer?.ok) {
    logger.warn("[external-account-credentials] org key readiness unavailable", {
      status: answer?.status ?? null,
    });
    throw new ExternalAccountCredentialRefusal(
      // A GitHub check whose approved credentials don't cover this run gets
      // that answer every time, so its copy names the fix, never a retry.
      answer?.code === "credential_policy_blocked"
        ? "This GitHub check is blocked by its approved credential policy. Approve the current commit again to run it."
        : "Couldn't check your organization's Cursor key. Try again in a moment.",
    );
  }
  if (answer.value.readiness !== "ready") {
    throw new ExternalAccountCredentialRefusal(ORG_KEY_MISSING_MESSAGE);
  }
  return {
    auth: Object.fromEntries(
      required.map((name) => [name, ""]),
    ),
  };
}
