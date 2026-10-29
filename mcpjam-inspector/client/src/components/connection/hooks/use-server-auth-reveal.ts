import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchServerSecretKeys,
  fetchServerSecrets,
} from "@/lib/apis/server-secrets-api";
import { WebApiError } from "@/lib/apis/web/base";
import {
  headerNamesWithoutBearer,
  splitAuthorizationHeader,
  type ServerAuth,
} from "../server-auth";

export interface ServerAuthRevealError {
  message: string;
  /** False when the backend refused the reveal: asking again gets the same
   * answer, so the eye stops offering it. */
  retryable: boolean;
}

export interface ServerAuthReveal {
  /** A saved value can be fetched: the server is saved to a project. */
  canReveal: boolean;
  /** Names of the stored custom headers, without an Authorization header that
   * holds the bearer token. Null until looked up, or if the lookup failed. */
  headerNames: string[] | null;
  /** The stored values, once revealed. */
  revealed: {
    bearerToken: string | undefined;
    entries: Array<[string, string]>;
  } | null;
  isRevealing: boolean;
  error: ServerAuthRevealError | null;
  /** Fetches every stored value at once. Resolves true when they landed. */
  reveal: () => Promise<boolean>;
}

const REVEAL_FAILED = "Could not load the saved value. Try again.";

/**
 * Saved credentials for the Auth tab of one server, fetched only when asked.
 *
 * Lives in the modal rather than the tab, because the tab remounts every time
 * it is selected: the header names are looked up at most once per modal open
 * (the lookup decrypts the whole secret set on the backend, see
 * `server-secrets.ts`), and revealed values survive a trip to another tab.
 * Everything is dropped when the modal closes or the server changes.
 */
export function useServerAuthReveal({
  projectId,
  serverId,
  auth,
  isOpen,
  wantsNames,
}: {
  projectId: string | null | undefined;
  serverId: string | null | undefined;
  auth: ServerAuth;
  isOpen: boolean;
  /** The Auth tab is showing; names are only worth a request then. */
  wantsNames: boolean;
}): ServerAuthReveal {
  const canReveal = !!projectId && !!serverId;
  const subject = isOpen && serverId ? serverId : null;

  const [headerNames, setHeaderNames] = useState<string[] | null>(null);
  const [revealed, setRevealed] = useState<ServerAuthReveal["revealed"]>(null);
  const [isRevealing, setIsRevealing] = useState(false);
  const [error, setError] = useState<ServerAuthRevealError | null>(null);
  const [stateSubject, setStateSubject] = useState(subject);
  const namesRequestedFor = useRef<string | null>(null);
  // Guards results that land after the modal closed or moved to another
  // server, so one server's secrets never appear on another's tab.
  const currentSubject = useRef(subject);
  currentSubject.current = subject;

  if (subject !== stateSubject) {
    setStateSubject(subject);
    setHeaderNames(null);
    setRevealed(null);
    setIsRevealing(false);
    setError(null);
  }
  if (subject === null) namesRequestedFor.current = null;

  const needsNames =
    wantsNames &&
    canReveal &&
    subject !== null &&
    auth.headers?.kind === "stored";
  useEffect(() => {
    if (!needsNames || !projectId || !serverId) return;
    if (namesRequestedFor.current === serverId) return;
    namesRequestedFor.current = serverId;
    const requestedFor = serverId;
    fetchServerSecretKeys({ projectId, serverId })
      .then(({ headerKeys }) => {
        if (currentSubject.current !== requestedFor) return;
        setHeaderNames(headerKeys);
      })
      .catch(() => {
        // Leaves the names unknown: the tab falls back to the single masked
        // field, whose eye fetches the values instead.
      });
  }, [needsNames, projectId, serverId]);

  const reveal = useCallback(async () => {
    if (!projectId || !serverId) return false;
    const requestedFor = serverId;
    setIsRevealing(true);
    setError(null);
    try {
      const secrets = await fetchServerSecrets({ projectId, serverId });
      if (currentSubject.current !== requestedFor) return false;
      setRevealed(splitAuthorizationHeader(auth.method, secrets.headers));
      return true;
    } catch (caught) {
      if (currentSubject.current !== requestedFor) return false;
      // A 403 is the credential broker refusing (not a manager of this
      // credential, or an export-deny policy); its message says why and who
      // can change it.
      setError(
        caught instanceof WebApiError && caught.status === 403
          ? { message: caught.message, retryable: false }
          : { message: REVEAL_FAILED, retryable: true },
      );
      return false;
    } finally {
      if (currentSubject.current === requestedFor) setIsRevealing(false);
    }
  }, [auth.method, projectId, serverId]);

  return {
    canReveal,
    headerNames:
      headerNames &&
      headerNamesWithoutBearer(
        auth.method,
        auth.bearer?.kind === "stored",
        headerNames,
      ),
    revealed,
    isRevealing,
    error,
    reveal,
  };
}
