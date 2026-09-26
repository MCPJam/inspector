import { useEffect, useState } from "react";
import {
  type ApiKeyMintEligibility,
  getApiKeyMintEligibility,
} from "@/lib/apis/web/api-keys";

/**
 * Whether the signed-in user may create an API key in `organizationId`
 * (MJ-010), so the create dialog can say so before the form is filled in.
 *
 * `null` while there is no answer: nothing selected, not `enabled`, the
 * request still in flight, or the check failed. The dialog then lets the user
 * try, because the server makes the same check when the key is created. An
 * answer is only ever returned for the organization it was asked about, so
 * switching organizations never shows the previous one's.
 */
export function useApiKeyMintEligibility(
  organizationId: string | null,
  enabled: boolean,
): ApiKeyMintEligibility | null {
  const [answer, setAnswer] = useState<{
    organizationId: string;
    eligibility: ApiKeyMintEligibility | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !organizationId) return;
    let current = true;
    void (async () => {
      let eligibility: ApiKeyMintEligibility | null = null;
      try {
        eligibility = await getApiKeyMintEligibility(organizationId);
      } catch {
        // No answer; creating is attempted and the server decides.
      }
      if (current) setAnswer({ organizationId, eligibility });
    })();
    return () => {
      current = false;
    };
  }, [organizationId, enabled]);

  return enabled && answer?.organizationId === organizationId
    ? answer.eligibility
    : null;
}
