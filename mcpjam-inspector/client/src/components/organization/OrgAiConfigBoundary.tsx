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
 * The failure the AI keys card EXPECTS: the deployment does not serve
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
 * Renders nothing when the AI keys query is not deployed, rather than taking
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

/**
 * A failure of the shared AI config query itself, by the query's name in the
 * message. {@link OrgAiConfigBoundary} shows and reports that one, once, for
 * every card that reads the query.
 */
export function isOrgAiConfigQueryError(error: Error): boolean {
  const message = typeof error?.message === "string" ? error.message : "";
  return message.includes(ORG_AI_CONFIG_QUERY);
}

/**
 * Isolates one AI settings card inside {@link OrgAiConfigBoundary}, so a
 * render bug in it shows a short error in its place and never takes the AI
 * keys switch down with it.
 *
 * A failure of the shared query is not this card's to show: the outer
 * boundary shows one message for it and reports it. Here it renders nothing
 * and is not reported a second time.
 */
export function OrgAiCardBoundary({
  name,
  title,
  children,
}: {
  name: string;
  /** What the card would have shown, for the error ("the default AI model"). */
  title: string;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      name={name}
      fallback={({ error, reset }) =>
        error && isOrgAiConfigQueryError(error) ? null : (
          <Alert variant="destructive" data-testid={`${name}-error`}>
            <AlertTitle>Couldn&apos;t show {title}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                Couldn&apos;t load this setting. Reload the page and try again.
              </p>
              <Button variant="outline" size="sm" onClick={reset}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )
      }
      isExpectedError={isOrgAiConfigQueryError}
    >
      {children}
    </ErrorBoundary>
  );
}
