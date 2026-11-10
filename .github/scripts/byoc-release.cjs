module.exports = async ({ github, context, core }) => {
  const [owner, repo] = (
    process.env.BACKEND_REPO || "MCPJam/mcpjam-backend"
  ).split("/");
  const sha = context.sha;
  const releaseTag = process.env.RELEASE_TAG;
  if (
    !owner ||
    !repo ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(releaseTag || "")
  ) {
    throw new Error(
      "BYOC dispatch requires a repository, full SHA and versioned release tag.",
    );
  }
  const { data: repository } = await github.rest.repos.get({ owner, repo });
  if (!repository.private)
    throw new Error(
      "BYOC source bundles require a private backend repository.",
    );
  await github.rest.repos.createDispatchEvent({
    owner,
    repo,
    event_type: "inspector_byoc_release",
    client_payload: { sha, release_tag: releaseTag },
  });
  core.info(
    `Requested a private BYOC candidate for ${releaseTag} (${sha}). This is not an installation or qualification result.`,
  );
  await core.summary
    .addRaw(
      `BYOC candidate requested: https://github.com/${owner}/${repo}/actions/workflows/selfhost-candidate.yml. Build and GCP qualification are separate results.\n`,
    )
    .write();
};
