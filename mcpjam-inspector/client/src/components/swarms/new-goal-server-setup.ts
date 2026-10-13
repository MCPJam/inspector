const invalidServerSetupCodes = new Set([
  "NO_TARGETS",
  "NO_SERVER_GROUP",
  "ENV_NOT_FOUND",
  "ENV_ARCHIVED",
  "ENV_CROSS_PROJECT",
  "ENV_HOST_MISSING",
  "ENV_ATTACHMENT_MISSING",
  "ENV_NO_SERVERS",
  "ENV_SERVERS_UNRESOLVED",
  "ENV_PLUGIN_UNAVAILABLE",
]);

export function newGoalErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (typeof code === "string" && invalidServerSetupCodes.has(code)) {
    return "This goal’s server setup is missing or invalid. Make sure its servers still exist and are explicitly selected.";
  }
  return error instanceof Error
    ? error.message
    : "The goal could not be saved. Try again.";
}
