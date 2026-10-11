// Queue configuration must build one PR at a time so labels and reviews apply
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

function approvedReviewers(reviews, pull) {
  const latest = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      latest.set(review.user?.login, review);
    }
  }
  return [...latest.values()].filter((review) =>
    review.state === "APPROVED" && review.commit_id === pull.head.sha &&
    review.user?.type === "User" && review.user.login !== pull.user.login
  ).map((review) => review.user.login);
}

async function enforceApprovals(github, context) {
  const pull = await resolvePull(github, context);
  if (!pull.labels.some((label) => label.name === "large-pr")) return;
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    ...context.repo, pull_number: pull.number, per_page: 100,
  });
  let count = 0;
  for (const username of approvedReviewers(reviews, pull)) {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      ...context.repo, username,
    });
    if (["write", "maintain", "admin"].includes(data.permission)) count += 1;
  }
  if (count < 2) {
    throw new Error(`large-pr requires two human approvals of the current head from reviewers with write access; found ${count}`);
  }
}

module.exports = { resolvePull, approvedReviewers, enforceApprovals };
