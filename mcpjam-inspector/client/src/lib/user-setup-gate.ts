interface ShouldShowUserSetupErrorOptions {
  hostedMode: boolean;
  isHostedChatRoute: boolean;
  isAuthenticated: boolean;
  currentUserIsNull: boolean;
}

/**
 * Decide whether to block the whole app with the full-screen
 * "Could not finish setup" error because the signed-in identity has no
 * backing account record yet.
 *
 * Only hosted (cloud) deployments require that record before rendering — it
 * backs orgs/projects/billing there, so without it the app genuinely can't
 * function. In local dev the app must still boot even when no record exists
 * for the session (the local backend doesn't always create one), which is
 * how startup behaved before inspector#1979 introduced this gate. Gating it
 * on hosted mode restores that behavior and fixes the regression where local
 * dev fell into the hard UserSetupError screen instead of just loading.
 */
export function shouldShowUserSetupError({
  hostedMode,
  isHostedChatRoute,
  isAuthenticated,
  currentUserIsNull,
}: ShouldShowUserSetupErrorOptions): boolean {
  return (
    hostedMode && !isHostedChatRoute && isAuthenticated && currentUserIsNull
  );
}
