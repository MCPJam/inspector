import { resolveCliVersion } from "./cli-version.mjs";

/** Registry visibility must not let a post-publish smoke test the prior release. */
export async function resolveSmokeCliVersion(
  selector,
  publishedVersion,
  resolve = resolveCliVersion,
) {
  const resolved = await resolve(selector);
  if (
    publishedVersion &&
    publishedVersion.split(".")[0] === selector &&
    resolved !== publishedVersion
  ) {
    throw new Error(
      "The published CLI is not the registry's current release in this major. Retry the release smoke after checking npm publication.",
    );
  }
  return resolved;
}
