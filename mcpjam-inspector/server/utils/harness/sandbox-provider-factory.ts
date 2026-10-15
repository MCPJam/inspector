/**
 * The one place a hosted harness turn gets its sandbox provider.
 *
 * Production is E2B, always: `HARNESS_SANDBOX_PROVIDER` unset (or `e2b`)
 * builds exactly the provider `run-harness-turn.ts` used to construct inline.
 * `HARNESS_SANDBOX_PROVIDER=docker` swaps in the Docker provider so the same
 * seam can run against a local container — for development and for the
 * hosted-harness CI job, which has no E2B account. It is REFUSED when
 * `NODE_ENV=production`: a deployed inspector attaching harness turns to
 * containers on its own host would bypass every isolation and egress control
 * the E2B box exists to provide. It is the only switch here; how the Docker
 * provider reaches a container port is read from the container itself.
 *
 * Only the harness seam moves. The other E2B call sites (the bash tool, the
 * terminal, uploads, skills sync) keep talking to E2B; under `docker` the
 * caller's "sandbox id" is the container to attach to.
 *
 * Every provider built here is wrapped by `observeHarnessBootstrap`, so the
 * phase-timing line can say whether the turn hit the baked template.
 */
import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";
import {
  createE2BHarnessSandboxProvider,
  type E2BHarnessSandboxProviderOptions,
} from "./e2b-sandbox-provider.js";
import { createDockerHarnessSandboxProvider } from "./docker/docker-sandbox-provider.js";
import { observeHarnessBootstrap } from "./harness-bake-observer.js";

export const HARNESS_SANDBOX_PROVIDER_ENV = "HARNESS_SANDBOX_PROVIDER";

export type HarnessSandboxProviderKind = "e2b" | "docker";

export function resolveHarnessSandboxProviderKind(
  env: NodeJS.ProcessEnv = process.env,
): HarnessSandboxProviderKind {
  const raw = env[HARNESS_SANDBOX_PROVIDER_ENV]?.trim().toLowerCase();
  if (!raw || raw === "e2b") return "e2b";
  if (raw === "docker") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        `${HARNESS_SANDBOX_PROVIDER_ENV}=docker is for development and CI only ` +
          "and is refused in production; unset it to use E2B",
      );
    }
    return "docker";
  }
  // Loud, not a silent fallback: a typo that quietly ran E2B would make the
  // Docker CI job pass while testing nothing it claims to.
  throw new Error(
    `${HARNESS_SANDBOX_PROVIDER_ENV}="${raw}" is not a sandbox provider ` +
      '(expected "e2b" or "docker")',
  );
}

/**
 * Build the turn's provider. Takes the E2B provider's options unchanged, so
 * the call site did not have to change shape; under `docker` the `sandboxId`
 * names the container.
 */
export function createHarnessSandboxProvider(
  opts: E2BHarnessSandboxProviderOptions,
  env: NodeJS.ProcessEnv = process.env,
): HarnessV1SandboxProvider {
  const kind = resolveHarnessSandboxProviderKind(env);
  const provider =
    kind === "docker"
      ? createDockerHarnessSandboxProvider({
          containerId: opts.sandboxId,
          ...(opts.defaultWorkingDirectory
            ? { defaultWorkingDirectory: opts.defaultWorkingDirectory }
            : {}),
          ...(opts.bridgePort !== undefined
            ? { bridgePort: opts.bridgePort }
            : {}),
          ...(opts.commandTimeoutMs !== undefined
            ? { commandTimeoutMs: opts.commandTimeoutMs }
            : {}),
          ...(opts.sessionEnv ? { sessionEnv: opts.sessionEnv } : {}),
          ...(opts.onSessionEnvUsed
            ? { onSessionEnvUsed: opts.onSessionEnvUsed }
            : {}),
        })
      : createE2BHarnessSandboxProvider(opts);
  return observeHarnessBootstrap(provider);
}
