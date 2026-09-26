import type {
  DesktopActivity,
  DiagnosticKind,
} from "../../../shared/desktop-diagnostics";

export function recordDesktopActivity(activity: DesktopActivity): void {
  try {
    window.electronAPI?.diagnostics?.record(activity);
  } catch {
    /* Best effort only. */
  }
}

export function desktopErrorCategory(
  error: unknown,
  status?: number,
): DesktopActivity["error"] {
  if (status === 401 || status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (error instanceof Error) {
    if (
      error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      /^Connection attempt timed out after \d+ seconds/.test(error.message)
    )
      return "timeout";
    if (
      error instanceof TypeError &&
      /^(Failed to fetch|fetch failed|Load failed|NetworkError when attempting to fetch resource)\.?$/.test(
        error.message,
      )
    )
      return "network";
  }
  return "other";
}

export function startDesktopOperation(kind: DiagnosticKind) {
  let operationId: string | undefined;
  try {
    if (!window.electronAPI?.diagnostics) return () => {};
    operationId = crypto.randomUUID();
  } catch {
    /* Older clients remain functional. */
  }
  recordDesktopActivity({ kind, phase: "start", operationId });
  let finished = false;
  return (success: boolean, error?: unknown, status?: number) => {
    if (finished) return;
    finished = true;
    recordDesktopActivity({
      kind,
      phase: success ? "success" : "failure",
      operationId,
      ...(status && status >= 100 && status <= 599 ? { status } : {}),
      ...(!success ? { error: desktopErrorCategory(error, status) } : {}),
    });
  };
}

export async function observeDesktopOperation<T>(
  kind: DiagnosticKind,
  work: (setStatus: (status: number) => void) => Promise<T>,
): Promise<T> {
  const finish = startDesktopOperation(kind);
  let status: number | undefined;
  try {
    const result = await work((value) => {
      status = value;
    });
    const resultSuccess =
      result && typeof result === "object" && "success" in result
        ? result.success
        : undefined;
    const success =
      (kind === "connect" || kind === "reconnect"
        ? resultSuccess === true
        : resultSuccess !== false) &&
      (status === undefined || status < 400);
    finish(success, undefined, status);
    return result;
  } catch (error) {
    const errorStatus =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : status;
    finish(false, error, errorStatus);
    throw error;
  }
}
