import { AsyncLocalStorage } from "node:async_hooks";

type ExecutionPolicy = {
  policy: "no_customer_credentials" | "suite_credentials";
  allowedBuiltInToolIds: readonly string[];
  checkAccess: () => Promise<unknown>;
};
const execution = new AsyncLocalStorage<ExecutionPolicy>();

export function isCredentialFreeGithubExecution(): boolean {
  return execution.getStore()?.policy === "no_customer_credentials";
}
export function githubExecutionPolicy() {
  return execution.getStore()?.policy;
}

export function withGithubCredentialPolicy<T>(
  policy: boolean | ExecutionPolicy,
  work: () => Promise<T>,
): Promise<T> {
  // Nested code cannot replace the parent's permissions or revocation check.
  const parent = execution.getStore();
  const next =
    typeof policy === "boolean"
      ? policy
        ? {
            policy: "no_customer_credentials" as const,
            allowedBuiltInToolIds: [],
            checkAccess: async () => {},
          }
        : undefined
      : policy;
  if (
    parent?.policy === "no_customer_credentials" ||
    (parent && next?.policy !== "no_customer_credentials")
  )
    return execution.run(parent, work);
  return execution.run(next!, work);
}

export function refuseGithubCredentialAccess(): void {
  if (isCredentialFreeGithubExecution())
    throw new Error("credential_policy_blocked");
}
export async function verifyGithubCredentialAccess(): Promise<void> {
  refuseGithubCredentialAccess();
  await execution.getStore()?.checkAccess();
}
export function requireGithubToolSelection(ids: readonly string[]): void {
  const policy = execution.getStore();
  if (
    policy &&
    (policy.policy === "no_customer_credentials" ||
      ids.some((id) => !policy.allowedBuiltInToolIds.includes(id)))
  )
    throw new Error("credential_policy_blocked");
}
