// Queue configuration must build one PR at a time so labels apply
// to the entire candidate, rather than just the last PR in a batch.
async function resolvePull(github, context) {
  const group = context.payload.merge_group;
  const number = context.payload.pull_request?.number ??
    Number(group?.head_ref.match(/\/pr-(\d+)-/)?.[1]);
  if (!number) throw new Error("Cannot identify the pull request");
  const { data: pull } = await github.rest.pulls.get({
    ...context.repo, pull_number: number,
  });
  if (pull.state !== "open") throw new Error("Pull request is no longer open");
  if (group && group.base_ref !== `refs/heads/${pull.base.ref}`) {
    throw new Error("Queue candidate targets a different base branch");
  }
  return pull;
}

module.exports = { resolvePull };
