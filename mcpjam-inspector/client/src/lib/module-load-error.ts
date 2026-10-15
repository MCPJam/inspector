export const MODULE_LOAD_ERROR_COPY = {
  title: "Please refresh the page",
  description: "Something didn’t load. Refresh to try again.",
  actionLabel: "Refresh",
} as const;

/** Match module import failures, not ordinary API/network errors. */
export function isModuleLoadError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? error.message
        : null;

  return (
    typeof message === "string" &&
    /^(?:TypeError: )?(?:Failed to fetch dynamically imported module:|error loading dynamically imported module:|Importing a module script failed\.?$)/i.test(
      message,
    )
  );
}
