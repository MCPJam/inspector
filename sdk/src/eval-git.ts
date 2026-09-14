import { execFile } from "node:child_process";
import type { EvalCiMetadata } from "./eval-reporting-types.js";

/** Bounded local discovery. No shell, remote, credentials, or repository-wide cache. */
export async function detectEvalGitMetadata(
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<EvalCiMetadata> {
  const timeoutMs = options.timeoutMs ?? 500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError("Git discovery timeout must be positive");
  const run = (args: string[]) =>
    new Promise<string | undefined>((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd: options.cwd,
          timeout: timeoutMs,
          maxBuffer: 64 * 1024,
          signal: options.signal,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout) => resolve(error ? undefined : stdout.trim())
      );
    });
  const [branch, sha, status] = await Promise.all([
    run(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    run(["rev-parse", "--verify", "HEAD"]),
    run(["status", "--porcelain=v1", "--untracked-files=normal"]),
  ]);
  return {
    ...(branch && branch.length <= 512 ? { branch } : {}),
    ...(sha && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha)
      ? { commitSha: sha }
      : {}),
    ...(status !== undefined ? { dirty: status.length > 0 } : {}),
  };
}
