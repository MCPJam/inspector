import {
  attachAuthChallenge,
  extractAuthChallenge,
  getNumericStatus,
  isUnauthorized401,
} from "./errors.js";

/**
 * A provider can refresh inside the transport before the manager sees failure.
 * An identity-bound session can then reject the retried request with 404.
 * Only a request with its own recorded 401 may rebuild and replay once.
 */
export async function recoverAuthProviderSession<T>(input: {
  error: unknown;
  challenged: boolean;
  reset: () => Promise<void>;
  retry: () => Promise<T>;
}): Promise<{ recovered: true; result: T } | { recovered: false }> {
  if (isUnauthorized401(input.error)) {
    // A redirect interrupted the call. The next explicit retry initializes a
    // new session after finishAuth rather than reusing the anonymous session.
    await input.reset();
    return { recovered: false };
  }
  const error = input.error;
  const status = getNumericStatus(error);
  const data =
    error && typeof error === "object" && "data" in error
      ? error.data
      : undefined;
  const dataStatus =
    data && typeof data === "object" && "status" in data
      ? data.status
      : undefined;
  if (!input.challenged || (status !== 404 && dataStatus !== 404))
    return { recovered: false };
  await input.reset();
  return { recovered: true, result: await input.retry() };
}

/** Preserve the original challenge when token refresh replaces its error. */
export async function runOperationWithAuthRecovery<T>(input: {
  run: () => Promise<T>;
  usesAuthProvider: boolean;
  attach: (error: unknown) => void;
  hasChallenge: () => boolean;
  reset: () => Promise<void>;
  refresh: (error: unknown) => Promise<boolean>;
}): Promise<T> {
  try {
    return await input.run();
  } catch (error) {
    input.attach(error);
    if (input.usesAuthProvider) {
      const recovery = await recoverAuthProviderSession({
        error,
        challenged: input.hasChallenge(),
        reset: input.reset,
        retry: () => runAndAttach(input.run, input.attach),
      });
      if (recovery.recovered) return recovery.result;
    }
    let refreshed: boolean;
    try {
      refreshed = await input.refresh(error);
    } catch (refreshError) {
      if (
        refreshError instanceof Error &&
        refreshError !== error &&
        Object.isExtensible(refreshError) &&
        refreshError.cause === undefined
      )
        refreshError.cause = error;
      const challenge = extractAuthChallenge(error);
      if (challenge) attachAuthChallenge(refreshError, challenge);
      throw refreshError;
    }
    if (!refreshed) throw error;
    return runAndAttach(input.run, input.attach);
  }
}

async function runAndAttach<T>(
  run: () => Promise<T>,
  attach: (error: unknown) => void
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    attach(error);
    throw error;
  }
}
