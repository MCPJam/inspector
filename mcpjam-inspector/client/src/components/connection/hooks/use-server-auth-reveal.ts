import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
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
  /** Drops the names and values, e.g. after a save replaced them, so the tab
   * looks them up again instead of showing the old ones. */
  reset: () => void;
}

const REVEAL_FAILED = "Could not load the saved value. Try again.";

/**
 * What a failed `fetchServerSecrets` tells the user. A 403 is the credential
 * broker refusing (not a manager of this credential, or an export-deny
 * policy): its message says why and who can change it, and asking again gets
 * the same answer. Anything else shows `fallback` and can be retried.
 */
export function describeRevealFailure(
  caught: unknown,
  fallback: string,
): ServerAuthRevealError {
  return caught instanceof WebApiError && caught.status === 403
    ? { message: caught.message, retryable: false }
    : { message: fallback, retryable: true };
}

/** Snapshots which server and reset a request started under, and answers
 * whether its result still belongs on the tab when it lands. */
function startRequest(
  subject: RefObject<string | null>,
  generation: RefObject<number>,
): () => boolean {
  const requestedFor = subject.current;
  const requestGeneration = generation.current;
  return () =>
    subject.current === requestedFor &&
    generation.current === requestGeneration;
}

/**
 * Saved credentials for the Auth tab of one server, fetched only when asked.
 *
 * Lives in the modal rather than the tab, because the tab remounts every time
 * it is selected: the header names are looked up at most once per modal open
 * (the lookup decrypts the whole secret set on the backend, see
 * `server-secrets.ts`), and revealed values survive a trip to another tab.
 * Everything is dropped when the modal closes, the server changes, or a save
 * calls `reset`.
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
  // Reruns the names lookup after a reset while the Auth tab is showing.
  const [resetCount, setResetCount] = useState(0);
  const namesRequestedFor = useRef<string | null>(null);
  // Guards results that land after the modal closed, moved to another server
  // or was reset by a save, so stale or foreign secrets never reach the tab.
  const currentSubject = useRef(subject);
  currentSubject.current = subject;
  const generation = useRef(0);

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
    const isCurrent = startRequest(currentSubject, generation);
    fetchServerSecretKeys({ projectId, serverId })
      .then(({ headerKeys }) => {
        if (!isCurrent()) return;
        setHeaderNames(headerKeys);
      })
      .catch(() => {
        // Leaves the names unknown: the tab falls back to the single masked
        // field, whose eye fetches the values instead.
      });
  }, [needsNames, projectId, serverId, resetCount]);

  const reveal = useCallback(async () => {
    if (!projectId || !serverId) return false;
    const isCurrent = startRequest(currentSubject, generation);
    setIsRevealing(true);
    setError(null);
    try {
      const secrets = await fetchServerSecrets({ projectId, serverId });
      if (!isCurrent()) return false;
      setRevealed(splitAuthorizationHeader(auth.method, secrets.headers));
      return true;
    } catch (caught) {
      if (!isCurrent()) return false;
      setError(describeRevealFailure(caught, REVEAL_FAILED));
      return false;
    } finally {
      if (isCurrent()) setIsRevealing(false);
    }
  }, [auth.method, projectId, serverId]);

  const reset = useCallback(() => {
    generation.current += 1;
    namesRequestedFor.current = null;
    setHeaderNames(null);
    setRevealed(null);
    setIsRevealing(false);
    setError(null);
    setResetCount((count) => count + 1);
  }, []);

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
    reset,
  };
}
