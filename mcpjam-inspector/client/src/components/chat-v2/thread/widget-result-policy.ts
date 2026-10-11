/** Failed calls are diagnostic results, never authority to start an App. */
export function isFailedWidgetResult(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    result.isError === true ||
    result.type === "error-text" ||
    result.type === "error-json"
  );
}
