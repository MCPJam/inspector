import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { HOSTED_MODE } from "@/lib/config";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useIsMemberActor } from "./use-is-member-actor";

// The backend's query, by name: this package does not import the backend's
// generated API. Mirrors `convex/hostedBrowser.ts` in mcpjam-backend.
const GET_HOSTED_BROWSER_AVAILABILITY = makeFunctionReference<"query">(
  "hostedBrowser:getAvailability",
);

/**
 * `inspector` is the WebMCP Inspector and the cloud browser a person drives;
 * `tools` is the `browser_*` model tools. They share a desktop but not every
 * prerequisite: the tool catalog entry matters only to `tools`.
 */
export type HostedBrowserSurface = "inspector" | "tools";

interface SurfaceAvailability {
  available: boolean;
  reason: string | null;
}

type Availability = Record<HostedBrowserSurface, SurfaceAvailability>;

interface HostedBrowserScope {
  organizationId?: string | null;
  projectId?: string | null;
}

const HostedBrowserScopeContext = createContext<HostedBrowserScope | null>(
  null,
);

/**
 * Where the hosted-browser question is asked from. Provided once around the
 * app chrome, because the hooks that read it sit in the sidebar, the host
 * editor and the playground alike, none of which receives the active
 * organization as a prop.
 */
export function HostedBrowserScopeProvider({
  organizationId,
  projectId,
  children,
}: HostedBrowserScope & { children: ReactNode }) {
  const scope = useMemo(
    () => ({ organizationId, projectId }),
    [organizationId, projectId],
  );
  return (
    <HostedBrowserScopeContext.Provider value={scope}>
      {children}
    </HostedBrowserScopeContext.Provider>
  );
}

/**
 * May the signed-in member use the hosted browser on this surface?
 *
 * The backend decides: the `hosted-browser` flag evaluated by the member's
 * email, as every launch path evaluates it, plus the deployment's readiness
 * (template, rate, Browser Panel keypair). Asking by project when one is
 * active gives the exact scope a launch is gated on.
 *
 * Tri-state, like the flag hooks it replaces: `undefined` while the answer is
 * not in yet, so a route guard waits rather than bouncing a member who
 * cold-loads a URL. A guest gets `false`. A failed query, or an answer without
 * the surface, also reads `false`: an older backend without the query offers
 * nothing it cannot launch, and a bad answer must not crash every component
 * that shows a browser control.
 */
function useHostedAnswer(surface: HostedBrowserSurface): boolean | undefined {
  const scope = useContext(HostedBrowserScopeContext);
  const isMember = useIsMemberActor();
  const isUserReady = useDbUserReady();
  const args = scope?.projectId
    ? { projectId: scope.projectId }
    : scope?.organizationId
      ? { organizationId: scope.organizationId }
      : null;
  const canAsk = isMember === true && isUserReady && !!args;
  const argsKey = args ? JSON.stringify(args) : "";
  // Unlike useQuery, useQueries returns a server error instead of throwing it
  // into the render of every component that shows a browser control.
  const queries = useMemo<Parameters<typeof useQueries>[0]>(
    (): Parameters<typeof useQueries>[0] =>
      canAsk && argsKey
        ? {
            availability: {
              query: GET_HOSTED_BROWSER_AVAILABILITY,
              args: JSON.parse(argsKey),
            },
          }
        : {},
    [canAsk, argsKey],
  );
  const result = useQueries(queries).availability as
    Availability | Error | null | undefined;

  if (isMember === false) return false;
  if (!canAsk || result === undefined) return undefined;
  if (result instanceof Error) return false;
  return result?.[surface]?.available === true;
}

function noHostedAnswer(): undefined {
  return undefined;
}

/**
 * Chosen once, at load: `HOSTED_MODE` is fixed for a build, so the hooks a
 * component calls never change between renders. A local build asks nothing,
 * and needs no Convex provider to answer `undefined`.
 */
export const useHostedBrowserAvailable: (
  surface: HostedBrowserSurface,
) => boolean | undefined = HOSTED_MODE ? useHostedAnswer : noHostedAnswer;
