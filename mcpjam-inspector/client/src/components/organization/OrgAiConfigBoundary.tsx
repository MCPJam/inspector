import type { ReactNode } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { isConvexQueryUnavailable } from "@/lib/convex-error";
import { ORG_AI_CONFIG_QUERY } from "@/hooks/useOrgAiConfig";

/**
 * The failure the AI-keys cards EXPECT: the deployment does not serve
 * `getOrganizationAiConfig` yet (an older backend, or a browser left open
 * across a rollback). `useQuery` throws during render in that state, with
 * Convex's "Could not find public function for '<name>'".
 *
 * Only that shape, and only for this query. Production redacts every
 * non-`ConvexError` to `Server Error`, which a real failure of this query
 * reads as too, so a redacted error is never assumed to be a missing
 * function: it surfaces (and reports) like any other failure.
 */
export function isOrgAiConfigUnavailable(error: Error): boolean {
  const message = typeof error?.message === "string" ? error.message : "";
  return (
    message.includes(ORG_AI_CONFIG_QUERY) && isConvexQueryUnavailable(error)
  );
}

/**
 * Renders nothing when the AI-keys query is not deployed, rather than taking
 * the AI providers page down or — worse — rendering a policy card that reads
 * as "off" on a backend that cannot say either way. Any other failure shows
 * an error in place of the card (and reports), never a silent gap.
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
      fallback={({ error, reset }) =>
        error && isOrgAiConfigUnavailable(error) ? null : (
          <Alert variant="destructive" data-testid="org-ai-config-error">
            <AlertTitle>Couldn&apos;t load the AI settings</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                The organization&apos;s AI keys setting couldn&apos;t be read.
                Try again in a moment.
              </p>
              <Button variant="outline" size="sm" onClick={reset}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )
      }
      isExpectedError={isOrgAiConfigUnavailable}
    >
      {children}
    </ErrorBoundary>
  );
}
