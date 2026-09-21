import { ERROR_MESSAGES } from "@/lib/error-messages";
import { getUserErrorMessage } from "@/lib/user-error";
import type {
  GithubCheckConnectionStatus,
  GithubCheckFeedbackComments,
  GithubInstallationBindingStatus,
} from "@/hooks/useGithubChecksSettings";

export const GITHUB_CHECKS_UNAVAILABLE_MESSAGE =
  ERROR_MESSAGES.githubUnavailable;
const GENERIC_WRITE_ERROR = ERROR_MESSAGES.githubSaveFailed;

/**
 * These legacy refusals have no stable backend codes yet. Exact known values
 * select catalog guidance; all other backend text gets the operation fallback.
 */
export function githubChecksWriteErrorMessage(
  error: unknown,
  fallback: string = GENERIC_WRITE_ERROR,
): string {
  let message: unknown;
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data: unknown }).data;
    message =
      typeof data === "string"
        ? data
        : data && typeof data === "object" && "message" in data
        ? data.message
        : undefined;
  }
  switch (message) {
    case "GitHub Checks settings are not currently available.":
      return ERROR_MESSAGES.githubUnavailable;
    case "Repository is not accessible to the MCPJam GitHub App.":
      return ERROR_MESSAGES.githubRepositoryAccess;
    case "GitHub could not be reached right now. Please try again.":
      return ERROR_MESSAGES.githubUnreachable;
    case "You are not an admin.":
      return ERROR_MESSAGES.githubAdminRequired;
    default:
      return getUserErrorMessage(error, fallback);
  }
}

/** Status is supplied by the backend, never inferred from display text. */
export const GITHUB_CONNECTION_STATUS_COPY = {
  verified: null,
  legacy_unverified:
    ERROR_MESSAGES.connectedBeforeMcpjamVerifiedRepositoriesReconnectItToKeepChecks,
  installation_inactive:
    ERROR_MESSAGES.theMcpjamGithubAppIsNotActiveOnThisAccount,
  repository_access_removed:
    ERROR_MESSAGES.theMcpjamGithubAppNoLongerHasAccessToThis,
} as const satisfies Record<GithubCheckConnectionStatus, string | null>;

export const GITHUB_CONNECTION_STATUS_LABEL = {
  verified: null,
  legacy_unverified: ERROR_MESSAGES.reconnectRequired,
  installation_inactive: ERROR_MESSAGES.appInactive,
  repository_access_removed: ERROR_MESSAGES.noAccess,
} as const satisfies Record<GithubCheckConnectionStatus, string | null>;

export const GITHUB_BINDING_STATUS_COPY = {
  active: ERROR_MESSAGES.connectedRepositoriesOnThisAccountCanRunChecks,
  suspended: ERROR_MESSAGES.suspendedOnGithubChecksArePausedForThisAccountUntil,
  removed: ERROR_MESSAGES.theAppWasUninstalledFromThisAccountReconnectItTo,
  unbound: ERROR_MESSAGES.disconnectedFromThisWorkspace,
} as const satisfies Record<GithubInstallationBindingStatus, string>;

export const GITHUB_UNBIND_CONFIRMATION =
  ERROR_MESSAGES.disconnectThisGithubAccountChecksOnItsRepositoriesStopImmediately;
export const GITHUB_BINDING_FAILED_MESSAGE =
  ERROR_MESSAGES.weCouldNotFinishConnectingThatGithubAccountThisIs;

export const GITHUB_FEEDBACK_COMMENTS_COPY = {
  on: ERROR_MESSAGES.mcpjamWillCommentOnPullRequestsInThisRepository,
  off: ERROR_MESSAGES.mcpjamWillStopCommentingOnPullRequestsInThisRepository,
} as const satisfies Record<GithubCheckFeedbackComments, string>;

export const GITHUB_FEEDBACK_COMMENTS_WRITE_FAILED_MESSAGE =
  ERROR_MESSAGES.githubCommentsFailed;

export function githubFeedbackCommentsErrorMessage(error: unknown): string {
  const message = githubChecksWriteErrorMessage(error);
  return message === GENERIC_WRITE_ERROR
    ? GITHUB_FEEDBACK_COMMENTS_WRITE_FAILED_MESSAGE
    : message;
}

export const GITHUB_CALLBACK_INCOMPLETE_MESSAGE =
  ERROR_MESSAGES.thisPageFinishesConnectingAGithubAccountAndItWas;
export const GITHUB_SIGNED_OUT_MESSAGE =
  ERROR_MESSAGES.youAreNotSignedInToMcpjamSoWeCould;
