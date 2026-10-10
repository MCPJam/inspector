import type { ReactNode } from "react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { isConvexQueryUnavailable } from "@/lib/convex-error";
import { ORG_AI_CONFIG_QUERY } from "@/hooks/useOrgAiConfig";

/**
 * The failure the AI-keys cards EXPECT: the deployment does not serve
 * `getOrganizationAiConfig` yet (an older backend, or a browser left open
 * across a rollback). `useQuery` throws during render in that state.
 *
 * Both shapes have to match. A dev deployment says "Could not find public
 * function for '<name>'"; production redacts every non-`ConvexError` to
 * `[CONVEX Q(<name>)] [Request ID: …] Server Error`, leaving the function name
 * in the prefix as the only thing to match on. The name is required either
 * way, so a failure of some other query is not mistaken for this one; a
 * `ConvexError` from this query carries its own message, matches neither
 * branch, and still reports.
 */
export function isOrgAiConfigUnavailable(error: Error): boolean {
  const message = typeof error?.message === "string" ? error.message : "";
  if (!message.includes(ORG_AI_CONFIG_QUERY)) return false;
  return isConvexQueryUnavailable(error) || message.includes("Server Error");
}

/**
 * Renders nothing when the AI-keys query is unavailable, rather than taking
 * the AI providers page down or — worse — rendering a policy card that reads
 * as "off" on a backend that cannot say either way.
 *
 * Keyed by the organization at the mount site: a boundary that has caught
 * stays in its fallback for the life of the element.
 */
export function OrgAiConfigBoundary({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      name={name}
      fallback={null}
      isExpectedError={isOrgAiConfigUnavailable}
    >
      {children}
    </ErrorBoundary>
  );
}
