import {
  compareCommits,
  getLatestEnvironmentDeployment
} from "@/lib/github";

interface Props {
  title: string;
  owner: string;
  repo: string;
  stagingEnvironment: string;
  productionEnvironment: string;
  /** Public repo URL for linking SHAs in the staging+production sync case. */
  repoUrl: string;
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs >= day) return `${Math.floor(diffMs / day)}d ago`;
  if (diffMs >= hour) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs >= minute) return `${Math.floor(diffMs / minute)}m ago`;
  return "just now";
}

type Category = "feat" | "fix" | "chore" | "other";

function categorize(message: string): Category {
  const m = message.toLowerCase();
  if (/^feat(\(|:|!)/.test(m)) return "feat";
  if (/^fix(\(|:|!)/.test(m)) return "fix";
  if (/^(chore|docs|refactor|test|build|ci|style|perf)(\(|:|!)/.test(m)) {
    return "chore";
  }
  return "other";
}

function describeCategories(
  counts: Record<Category, number>,
  total: number
): string {
  const parts: string[] = [];
  if (counts.feat > 0) parts.push(`${counts.feat} feature${counts.feat === 1 ? "" : "s"}`);
  if (counts.fix > 0) parts.push(`${counts.fix} fix${counts.fix === 1 ? "" : "es"}`);
  if (counts.chore > 0) parts.push(`${counts.chore} chore${counts.chore === 1 ? "" : "s"}`);
  if (counts.other > 0) {
    parts.push(`${counts.other} other commit${counts.other === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : `${total} commit${total === 1 ? "" : "s"}`;
}

function Tile({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-6 bg-white/0">
      <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export async function DeployDiff({
  title,
  owner,
  repo,
  stagingEnvironment,
  productionEnvironment,
  repoUrl
}: Props) {
  let staging, production;
  try {
    [staging, production] = await Promise.all([
      getLatestEnvironmentDeployment(owner, repo, stagingEnvironment),
      getLatestEnvironmentDeployment(owner, repo, productionEnvironment)
    ]);
  } catch (err) {
    return (
      <Tile title={title}>
        <p className="text-sm text-red-500">
          Failed to read deployments: {(err as Error).message}
        </p>
      </Tile>
    );
  }

  if (!production) {
    return (
      <Tile title={title}>
        <p className="text-sm text-neutral-500">
          No successful production deployment recorded for{" "}
          <code>{productionEnvironment}</code>.
        </p>
      </Tile>
    );
  }
  if (!staging) {
    return (
      <Tile title={title}>
        <p className="text-sm text-neutral-500">
          No successful staging deployment recorded for{" "}
          <code>{stagingEnvironment}</code>.
        </p>
      </Tile>
    );
  }

  if (staging.sha === production.sha) {
    return (
      <Tile title={title}>
        <p className="text-sm text-neutral-500">
          In sync on{" "}
          <a
            href={`${repoUrl}/commit/${production.sha}`}
            className="font-mono text-neutral-400 hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            {production.sha.slice(0, 7)}
          </a>
          . Last promoted {formatRelativeTime(production.createdAt)}.
        </p>
      </Tile>
    );
  }

  let diff;
  try {
    diff = await compareCommits(owner, repo, production.sha, staging.sha);
  } catch (err) {
    return (
      <Tile title={title}>
        <p className="text-sm text-red-500">
          Failed to compare commits: {(err as Error).message}
        </p>
      </Tile>
    );
  }

  const counts: Record<Category, number> = {
    feat: 0,
    fix: 0,
    chore: 0,
    other: 0
  };
  for (const c of diff.commits) {
    counts[categorize(c.message)]++;
  }

  const commitWord = diff.aheadBy === 1 ? "commit" : "commits";
  const breakdown = describeCategories(counts, diff.aheadBy);
  const compareUrl = `${repoUrl}/compare/${production.sha}...${staging.sha}`;

  // GitHub Compare returns commits in chronological order (oldest first).
  // Flip so the newest work shows up on top — that's what matters when
  // deciding "should we cut a release?". Overflow count uses `aheadBy`
  // rather than `commits.length` because the compare endpoint caps commits
  // at 250 for wide diffs.
  const preview = diff.commits.slice(-8).reverse();
  const hidden = diff.aheadBy - preview.length;

  return (
    <Tile title={title}>
      <p className="text-sm text-neutral-500">
        Production is{" "}
        <a
          href={compareUrl}
          className="font-medium text-neutral-700 dark:text-neutral-200 hover:underline"
          target="_blank"
          rel="noreferrer"
        >
          {diff.aheadBy} {commitWord} behind staging
        </a>{" "}
        ({breakdown}). Last promoted{" "}
        {formatRelativeTime(production.createdAt)}.
      </p>

      <ul className="mt-4 space-y-1">
        {preview.map((c) => (
          <li key={c.sha} className="text-xs text-neutral-500">
            <a
              href={c.url}
              className="font-mono text-neutral-400 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              {c.sha.slice(0, 7)}
            </a>{" "}
            <span className="text-neutral-700 dark:text-neutral-200">
              {c.message}
            </span>{" "}
            <span className="text-neutral-400">— {c.author}</span>
          </li>
        ))}
        {hidden > 0 && (
          <li className="text-xs text-neutral-400">
            + {hidden} earlier commit{hidden === 1 ? "" : "s"}
          </li>
        )}
      </ul>
    </Tile>
  );
}

export function DeployDiffSkeleton({ title }: { title: string }) {
  return (
    <Tile title={title}>
      <p className="text-sm text-neutral-400">Loading…</p>
    </Tile>
  );
}
