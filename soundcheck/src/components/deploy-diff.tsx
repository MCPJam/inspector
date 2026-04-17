import {
  compareCommits,
  getLatestEnvironmentDeployment
} from "@/lib/github";
import { formatRelativeTime, shortSha } from "@/lib/format";
import { HeroStat, Sha, Tile, TileAction } from "@/components/ui";
import type { StatusTone } from "@/components/ui";

interface Props {
  title: string;
  owner: string;
  repo: string;
  stagingEnvironment: string;
  productionEnvironment: string;
  /** Public repo URL for linking SHAs in the staging+production sync case. */
  repoUrl: string;
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

const CATEGORY_LABEL: Record<Category, string> = {
  feat: "features",
  fix: "fixes",
  chore: "chores",
  other: "other"
};

const CATEGORY_COLOR: Record<Category, string> = {
  feat: "text-signal-go",
  fix: "text-signal-wait",
  chore: "text-ink-300",
  other: "text-ink-400"
};

function driftTone(aheadBy: number, promotedIso: string): StatusTone {
  const ageDays =
    (Date.now() - new Date(promotedIso).getTime()) / (24 * 60 * 60 * 1000);
  if (aheadBy === 0) return "success";
  if (aheadBy > 100 || ageDays > 21) return "warning";
  return "info";
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
      <Tile title={title} accent="failure">
        <p className="text-sm text-signal-stop">
          Failed to read deployments: {(err as Error).message}
        </p>
      </Tile>
    );
  }

  if (!production) {
    return (
      <Tile title={title} accent="warning">
        <p className="text-sm text-ink-400">
          No successful production deployment recorded for{" "}
          <code className="font-mono text-ink-200">
            {productionEnvironment}
          </code>
          .
        </p>
      </Tile>
    );
  }
  if (!staging) {
    return (
      <Tile title={title} accent="warning">
        <p className="text-sm text-ink-400">
          No successful staging deployment recorded for{" "}
          <code className="font-mono text-ink-200">{stagingEnvironment}</code>.
        </p>
      </Tile>
    );
  }

  if (staging.sha === production.sha) {
    return (
      <Tile
        title={title}
        eyebrow="In sync"
        accent="success"
        action={<TileAction href={`${repoUrl}/commits/main`}>history</TileAction>}
      >
        <HeroStat
          value="0"
          tone="success"
          label="Staging = production"
          sublabel={
            <>
              On <Sha href={`${repoUrl}/commit/${production.sha}`} sha={shortSha(production.sha)} />
              {" "}· last promoted {formatRelativeTime(production.createdAt)}
            </>
          }
        />
      </Tile>
    );
  }

  let diff;
  try {
    diff = await compareCommits(owner, repo, production.sha, staging.sha);
  } catch (err) {
    return (
      <Tile title={title} accent="failure">
        <p className="text-sm text-signal-stop">
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

  const compareUrl = `${repoUrl}/compare/${production.sha}...${staging.sha}`;
  const preview = diff.commits.slice(-6).reverse();
  const hidden = diff.aheadBy - preview.length;
  const tone = driftTone(diff.aheadBy, production.createdAt);

  return (
    <Tile
      title={title}
      eyebrow="Production behind staging"
      accent={tone}
      action={<TileAction href={compareUrl}>compare</TileAction>}
    >
      <HeroStat
        value={diff.aheadBy}
        tone={tone}
        label={diff.aheadBy === 1 ? "commit ahead" : "commits ahead"}
        sublabel={`Last promoted ${formatRelativeTime(production.createdAt)}`}
        href={compareUrl}
      />

      {/* Category breakdown — small strip with typed counts */}
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1 text-[11px] font-medium uppercase tracking-wider">
        {(Object.keys(counts) as Category[]).map((cat) =>
          counts[cat] > 0 ? (
            <span key={cat} className={CATEGORY_COLOR[cat]}>
              <span className="tabular-nums">{counts[cat]}</span>
              <span className="ml-1 text-ink-500">{CATEGORY_LABEL[cat]}</span>
            </span>
          ) : null
        )}
      </div>

      <div className="my-5 hairline" />

      {/* Commit feed */}
      <ul className="space-y-2">
        {preview.map((c) => (
          <li key={c.sha} className="group flex gap-3 text-xs leading-relaxed">
            <Sha href={c.url} sha={shortSha(c.sha)} />
            <div className="min-w-0 flex-1">
              <span className="text-ink-100">{truncate(c.message, 84)}</span>
              <span className="ml-2 text-ink-500">— {c.author}</span>
            </div>
          </li>
        ))}
        {hidden > 0 && (
          <li className="pt-1 text-[11px] italic text-ink-500">
            + {hidden} earlier commit{hidden === 1 ? "" : "s"}
          </li>
        )}
      </ul>
    </Tile>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

export function DeployDiffSkeleton({ title }: { title: string }) {
  return (
    <Tile title={title} eyebrow="Computing diff">
      <div className="flex items-end gap-4">
        <span className="display-hero text-6xl text-ink-700 animate-pulse">
          …
        </span>
        <div className="pb-2">
          <div className="h-3 w-32 rounded bg-ink-800 animate-pulse" />
          <div className="mt-2 h-2.5 w-24 rounded bg-ink-800/60 animate-pulse" />
        </div>
      </div>
    </Tile>
  );
}
