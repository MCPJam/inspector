/**
 * MCP staging drift tile.
 *
 * The MCP Cloudflare Worker has no production environment today — only
 * `mcpjam-mcp-staging`, auto-deployed by deploy-mcp-staging.yml on every
 * push to main. So the Deploy Diff shape (staging vs prod) doesn't apply.
 * Instead, this tile answers: "what SHA is live on staging, and how many
 * main commits are ahead of it?"
 *
 * Data:
 *   - `live SHA` = `head_sha` of the latest successful `deploy-mcp-staging.yml`
 *     run on main. Picking the latest *successful* run (not just latest
 *     run) ensures a red deploy doesn't look like the current state.
 *   - `main SHA` = head of the inspector repo's main branch.
 *   - Drift = `compare/<live>...<main>`.
 *
 * Tone semantics: drift is almost always "info" for MCP because most main
 * commits won't touch `mcp/` — a large count is expected and not a
 * concern. Only genuinely stale deploys (>21d without an mcp-touching
 * commit landing, which would imply the staging auto-deploy is broken)
 * escalate to "warning".
 */

import {
  compareCommits,
  findLatestSuccessfulRun,
  getBranchHead,
  type BranchHead,
  type WorkflowRun
} from "@/lib/github";
import { formatRelativeTime, shortSha } from "@/lib/format";
import { HeroStat, Sha, Tile, TileAction } from "@/components/ui";
import type { StatusTone } from "@/components/ui";

const INSPECTOR = { owner: "MCPJam", repo: "inspector" };
const MCP_STAGING_WORKFLOW = "deploy-mcp-staging.yml";
const REPO_URL = "https://github.com/MCPJam/inspector";

/**
 * Prefer `runStartedAt` (when the current attempt began doing work) over
 * `updatedAt` (last status transition — can drift on re-runs). Within a few
 * seconds for a normal ~30s deploy, but semantically clearer for a tile
 * whose headline claim is "last deployed".
 */
function deployedAt(run: WorkflowRun): string {
  return run.runStartedAt ?? run.updatedAt;
}

function driftTone(aheadBy: number, liveDeployedIso: string): StatusTone {
  if (aheadBy === 0) return "success";
  const deployedMs = Date.parse(liveDeployedIso);
  if (!Number.isFinite(deployedMs)) return "warning";
  const ageDays = (Date.now() - deployedMs) / (24 * 60 * 60 * 1000);
  // Most main commits don't touch `mcp/` — large aheadBy is expected, not
  // alarming. Only stale-by-time (no mcp-touching deploy in 3 weeks) escalates.
  if (ageDays > 21) return "warning";
  return "info";
}

export function McpDeployStatusSkeleton() {
  return (
    <Tile title="MCP" eyebrow="Computing drift">
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

export async function McpDeployStatus() {
  let liveRun: WorkflowRun | null;
  let mainHead: BranchHead;
  try {
    [liveRun, mainHead] = await Promise.all([
      findLatestSuccessfulRun(
        INSPECTOR.owner,
        INSPECTOR.repo,
        MCP_STAGING_WORKFLOW,
        "main"
      ),
      getBranchHead(INSPECTOR.owner, INSPECTOR.repo, "main")
    ]);
  } catch (err) {
    return (
      <Tile title="MCP" accent="failure">
        <p className="text-sm text-signal-stop">
          Failed to read MCP state: {(err as Error).message}
        </p>
      </Tile>
    );
  }

  if (!liveRun) {
    return (
      <Tile title="MCP" accent="warning">
        <p className="text-sm text-ink-400">
          No successful{" "}
          <code className="font-mono text-ink-200">deploy-mcp-staging.yml</code>{" "}
          run on record.
        </p>
      </Tile>
    );
  }

  const runAction = (
    <TileAction href={liveRun.htmlUrl}>Run #{liveRun.id}</TileAction>
  );

  if (liveRun.headSha === mainHead.sha) {
    return (
      <Tile title="MCP" eyebrow="In sync" accent="success" action={runAction}>
        <HeroStat
          value="0"
          tone="success"
          label="Staging = main"
          sublabel={
            <>
              On{" "}
              <Sha
                href={`${REPO_URL}/commit/${liveRun.headSha}`}
                sha={shortSha(liveRun.headSha)}
              />{" "}
              · last deployed {formatRelativeTime(deployedAt(liveRun))}
            </>
          }
        />
      </Tile>
    );
  }

  let diff;
  try {
    diff = await compareCommits(
      INSPECTOR.owner,
      INSPECTOR.repo,
      liveRun.headSha,
      mainHead.sha
    );
  } catch (err) {
    return (
      <Tile title="MCP" accent="failure" action={runAction}>
        <p className="text-sm text-signal-stop">
          Failed to compare commits: {(err as Error).message}
        </p>
      </Tile>
    );
  }

  const compareUrl = `${REPO_URL}/compare/${liveRun.headSha}...${mainHead.sha}`;
  const preview = diff.commits.slice(-6).reverse();
  const hidden = diff.aheadBy - preview.length;
  const tone = driftTone(diff.aheadBy, deployedAt(liveRun));

  return (
    <Tile
      title="MCP"
      eyebrow="Staging behind main"
      accent={tone}
      action={<TileAction href={compareUrl}>compare</TileAction>}
    >
      <HeroStat
        value={diff.aheadBy}
        tone={tone}
        label={diff.aheadBy === 1 ? "commit ahead" : "commits ahead"}
        sublabel={
          <>
            Most won&rsquo;t touch <code className="font-mono text-ink-200">mcp/</code>{" "}
            · next deploy fires when one does · last deployed{" "}
            {formatRelativeTime(deployedAt(liveRun))}
          </>
        }
        href={compareUrl}
      />

      <div className="my-5 hairline" />

      <ul className="space-y-2">
        {preview.map((c) => (
          <li key={c.sha} className="flex gap-3 text-xs leading-relaxed">
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
