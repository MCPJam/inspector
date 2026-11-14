/**
 * The name a conformance run's target goes by: the saved server's name while
 * the project still has it, otherwise what the run was pointed at.
 *
 * CLI, SDK, API and GitHub runs record a URL, a ref or a repository instead
 * of a saved server, and their target key carries a kind prefix
 * (`url:https://…`, `ref:…`, `github_repo:<id>`) that is storage, not a name.
 */
export function conformanceRunTargetName(
  run: {
    targetKey: string;
    serverId: string | null;
    ciMetadata?: { repository?: string } | null;
  },
  serverNames?: ReadonlyMap<string, string>,
): string {
  const saved = run.serverId ? serverNames?.get(run.serverId) : undefined;
  if (saved) return saved;

  const separator = run.targetKey.indexOf(":");
  if (separator === -1) return run.targetKey;
  const kind = run.targetKey.slice(0, separator);
  const value = run.targetKey.slice(separator + 1);
  // A repository's key is a config id; the CI metadata names the repository.
  if (kind === "github_repo")
    return run.ciMetadata?.repository || "GitHub repository";
  return value || run.targetKey;
}
