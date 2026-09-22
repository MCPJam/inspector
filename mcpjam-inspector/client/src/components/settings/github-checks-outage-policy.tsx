import { SelectItem } from "@mcpjam/design-system/select";
import type { GithubCheckOutagePolicy } from "@/hooks/useGithubChecksSettings";

/**
 * The outage-policy vocabulary, in ONE place because two surfaces connect a
 * repository — Settings → Integrations → GitHub, and the suite's own "run this
 * on every pull request" section — and the two must not describe the same
 * stored value differently.
 *
 * The wording is the careful part. MCPJam decides what the check CONCLUDES
 * (`neutral` for fail open, `failure` for fail closed) and nothing beyond that.
 * Whether either conclusion stops a merge is branch protection's answer, which
 * lives in the repository's GitHub settings — MCPJam can neither read it nor
 * set it. So "merges proceed" and "merges are blocked" are promises made on
 * someone else's behalf, and copy here never makes them: it states the
 * conclusion, then names branch protection as the thing that acts on it.
 */
export const OUTAGE_POLICY_LABELS: Record<GithubCheckOutagePolicy, string> = {
  fail_open: "Fail open",
  fail_closed: "Fail closed",
};

/** The two options, for any `SelectContent` that offers the policy. */
export function OutagePolicySelectItems() {
  return (
    <>
      <SelectItem value="fail_open">
        {OUTAGE_POLICY_LABELS.fail_open}
      </SelectItem>
      <SelectItem value="fail_closed">
        {OUTAGE_POLICY_LABELS.fail_closed}
      </SelectItem>
    </>
  );
}

/**
 * What each policy means, shown BEFORE the choice rather than inside the
 * dropdown: an option label cannot say what the check will conclude, and this
 * is the decision an administrator is least likely to revisit later.
 */
export function OutagePolicyExplainer({ className }: { className?: string }) {
  return (
    <div className={className}>
      <p>
        <span className="font-medium text-foreground">
          {OUTAGE_POLICY_LABELS.fail_open}:
        </span>{" "}
        During an MCPJam outage or pause, the check reports neutral.
      </p>
      <p>
        <span className="font-medium text-foreground">
          {OUTAGE_POLICY_LABELS.fail_closed}:
        </span>{" "}
        During an MCPJam outage or pause, the check reports failed.
      </p>
      <p>
        Whether a failed or neutral check blocks merging depends on this
        repository&apos;s branch-protection settings.
      </p>
    </div>
  );
}
