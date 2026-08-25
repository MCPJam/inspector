import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";

/**
 * What connecting a repository to MCPJam's PR checks authorizes — the data
 * half of that decision, at the moment it is made.
 *
 * WHY IT LIVES HERE AND NOT ON THE RUN. A pull-request check has no pre-run
 * human moment: nobody approves the run that a push triggers, and the check
 * concludes on a stranger's pull request minutes later. Connecting the
 * repository IS the consent moment for every run that follows it, so it is the
 * only place this can be said before the fact.
 *
 * ONE place, like `OutagePolicyExplainer` beside it, because two surfaces
 * connect a repository — Settings → Integrations → GitHub, and the suite's own
 * "run this on every pull request" section. Two connect affordances that
 * describe the same authorization differently is the failure this module
 * exists to prevent.
 *
 * COPY DISCIPLINE, and it is the whole difficulty of the file: every sentence
 * here is a fact the platform actually enforces today, in the register of
 * `evals/run-disclosure-hint.tsx` and the CLI's pre-run block. Two of them are
 * load-bearing and easy to soften into something friendlier and false:
 *
 *   * redaction is NOT a DLP system. `evalIngestRedaction` documents its own
 *     blind spot — a bare opaque secret in ordinary prose is not detected —
 *     and copy that names a redaction module without that caveat reads as
 *     coverage it does not have.
 *   * retention is NOT enforced yet. `effectiveToday` is `kept-indefinitely`
 *     until the sweep gate opens, so "retained per your plan's policy" alone
 *     would be a promise about a mechanism that is not running. The honest
 *     sentence says the policy applies once enforcement is on, and that the
 *     evidence is kept until then.
 *
 * A MISSING FACT MUST NEVER BECOME A REASSURING SENTENCE: the per-run facts
 * (which models, which destinations, which analyzers fired) vary per run and
 * are not knowable here, so this block points at the run's own disclosure
 * rather than guessing at them.
 */
export function ConnectRepoDataHandlingNote({
  className,
}: {
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={className}>
      {/* One line visible, specifics behind the expand. The visible sentence
          has to survive alone — most people will never open the details, so it
          carries the two facts that change the decision: this runs on every
          pull request, and it calls models with that pull request's code. */}
      <p>
        Connecting lets MCPJam build and run this repository&apos;s pull
        requests, calling the suite&apos;s models with what it finds there.
      </p>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid="connect-repo-data-handling-toggle"
            className="mt-1 flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={`size-3 transition-transform ${
                open ? "" : "-rotate-90"
              }`}
              aria-hidden
            />
            What connecting authorizes
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1 space-y-1">
          <p>
            Every pull request opened on this repository triggers a run. MCPJam
            builds that pull request&apos;s MCP server from its source in an
            isolated sandbox and runs the suite against it. Pull requests from
            forks are never built.
          </p>
          <p>
            Each run calls the models the suite is configured with, through
            whichever provider that configuration routes to. Analyzers and
            judges configured for the suite may run when it completes and send
            the run&apos;s evidence to their own model provider.
          </p>
          <p>
            The run&apos;s content is stored in MCPJam. Credential-shaped values
            are redacted on the way in; that is not a DLP system, so a secret
            written in ordinary prose is not detected.
          </p>
          <p>
            Evidence is retained under your plan&apos;s policy once retention
            enforcement is enabled, and kept until then.
          </p>
          <p>
            The exact facts for any one run — which models it called, where they
            routed, which analyzers fired — are on that run&apos;s page in
            MCPJam.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
