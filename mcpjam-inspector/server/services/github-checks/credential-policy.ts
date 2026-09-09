import { AsyncLocalStorage } from "node:async_hooks";

// Set only by the service-authenticated GitHub worker. Nested asynchronous
// work inherits the restriction; a nested caller cannot turn it off.
const execution = new AsyncLocalStorage<boolean>();

export function isCredentialFreeGithubExecution(): boolean {
  return execution.getStore() === true;
}

export function withGithubCredentialPolicy<T>(
  restricted: boolean,
  work: () => Promise<T>,
): Promise<T> {
  return execution.run(isCredentialFreeGithubExecution() || restricted, work);
}

export function refuseGithubCredentialAccess(): void {
  if (isCredentialFreeGithubExecution())
    throw new Error("credential_policy_blocked");
}
