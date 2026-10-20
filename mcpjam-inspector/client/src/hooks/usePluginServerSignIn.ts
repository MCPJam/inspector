import { useCallback, useState } from "react";
import { useConvex, useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useAuth } from "@workos-inc/authkit-react";
import { HOSTED_MODE } from "@/lib/config";
import { convexErrMessage, isConvexQueryUnavailable } from "@/lib/convex-error";
import { cancelOnboardingAfterSignIn } from "@/lib/plugin-onboarding-intent";
import {
  startPluginServerSignIn,
  type PluginServerSignInTarget,
  type PluginServerSignInRequest,
} from "@/lib/plugins/plugin-sign-in";
import { toast } from "@/lib/toast";
import type { RemoteProject } from "./useProjects";

const resolveSignIn = makeFunctionReference<
  "query",
  { projectId: string; pluginVersionId: string; componentKey: string },
  PluginServerSignInTarget
>("pluginSignIn:resolvePluginServerSignIn");

const myProjects = makeFunctionReference<
  "query",
  Record<string, never>,
  RemoteProject[]
>("projects:getMyProjects");

export const PLUGIN_SIGN_IN_UNAVAILABLE_MESSAGE =
  "Signing in to a plugin's server isn't available here yet.";

const PLUGIN_SIGN_IN_FAILED_MESSAGE = "Couldn't start the sign-in. Try again.";

/**
 * `redirecting`: the page is leaving for the authorization server.
 * `signed_in`: the flow finished without leaving. `failed`: it said why.
 */
export type PluginSignInOutcome = "redirecting" | "signed_in" | "failed";

/**
 * The one Sign in action for a plugin's server, shared by its Settings, its
 * server card and the chat's plugin notice.
 *
 * Hosted builds only. A plugin server runs with the credential the backend
 * holds for the member, and only the hosted flow stores one there; a build
 * that keeps credentials on this computer would sign in to nothing a chat
 * uses, so it offers no Sign in (`available` is false).
 */
export function usePluginServerSignIn(projectId: string | null) {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const available = HOSTED_MODE && isAuthenticated && !!projectId;
  const projects = useQuery(myProjects, available ? {} : "skip");
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const signIn = useCallback(
    async (
      binding: PluginServerSignInRequest,
      options?: {
        returnPath?: string;
        /** Set up's own sign-in, which the request it kept waits on. */
        keepsSetUp?: boolean;
      },
    ): Promise<PluginSignInOutcome> => {
      if (!available || !projectId) return "failed";
      // A Set up kept for an earlier sign-in waits on that one alone. Any
      // other drops it, so finishing this one starts no setup.
      if (!options?.keepsSetUp) cancelOnboardingAfterSignIn();
      setPendingKey(binding.componentKey);
      try {
        const target = await convex.query(resolveSignIn, {
          projectId,
          pluginVersionId: binding.pluginVersionId,
          componentKey: binding.componentKey,
        });
        const result = await startPluginServerSignIn({
          target,
          ...(binding.scopeChallenge
            ? { scopeChallenge: binding.scopeChallenge }
            : {}),
          projectId,
          organizationId:
            projects?.find((project) => project._id === projectId)
              ?.organizationId ?? null,
          initiatingUserId: user?.id ?? null,
          ...(options?.returnPath ? { returnPath: options.returnPath } : {}),
        });
        if (!result.success) {
          toast.error(result.error ?? PLUGIN_SIGN_IN_FAILED_MESSAGE);
          return "failed";
        }
        return result.serverConfig ? "signed_in" : "redirecting";
      } catch (error) {
        toast.error(
          error instanceof Error && isConvexQueryUnavailable(error)
            ? PLUGIN_SIGN_IN_UNAVAILABLE_MESSAGE
            : convexErrMessage(error, PLUGIN_SIGN_IN_FAILED_MESSAGE),
        );
        return "failed";
      } finally {
        setPendingKey(null);
      }
    },
    [available, convex, projectId, projects, user?.id],
  );

  return { available, pendingKey, signIn };
}
