import { Suspense } from "react";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { isAllowedEmployeeEmail, isLockdownEnabled } from "@/lib/lockdown";
import {
  DeployDiff,
  DeployDiffSkeleton
} from "@/components/deploy-diff";
import {
  ReleaseReadiness,
  ReleaseReadinessSkeleton
} from "@/components/release-readiness";
import {
  ReleaseDryRun,
  ReleaseDryRunSkeleton
} from "@/components/release-dry-run";
import {
  ReleaseProgress,
  ReleaseProgressSkeleton
} from "@/components/release-progress";
import {
  DeployFailures,
  DeployFailuresSkeleton
} from "@/components/deploy-failures";
import { RunRelease } from "@/components/run-release";
import { ReleaseVerdict, ReleaseVerdictSkeleton } from "@/components/release-verdict";
import { Section } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { user } = await withAuth({ ensureSignedIn: true });

  if (isLockdownEnabled() && !isAllowedEmployeeEmail(user.email)) {
    return (
      <main className="mx-auto max-w-xl px-6 py-24">
        <div className="panel panel-accent-stop p-8">
          <h1 className="display-hero text-3xl text-ink-100">Not authorized.</h1>
          <p className="mt-3 text-sm text-ink-400">
            Soundcheck is restricted to MCPJam employees. If you think this is
            a mistake, reach out in <span className="font-mono text-ink-200">#ops</span>.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-14 md:px-10 md:py-20">
      {/* Wordmark + meta */}
      <header className="mb-12 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-ink-500">
            MCPJam · internal ops
          </div>
          <h1 className="display-hero mt-3 text-6xl md:text-7xl text-ink-50">
            Soundcheck<span className="text-signal-wait">.</span>
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-400">
            One control plane for the release pipeline. Everything below
            answers a question you&rsquo;d otherwise go hunting for across
            GitHub, Railway, Convex, Cloudflare, and npm.
          </p>
        </div>
        <div className="text-xs text-ink-500">
          <div>Signed in as</div>
          <div className="mt-0.5 font-mono text-ink-200">{user.email}</div>
        </div>
      </header>

      {/* Verdict strip — instant "go / hold" */}
      <div className="mb-14">
        <Suspense fallback={<ReleaseVerdictSkeleton />}>
          <ReleaseVerdict />
        </Suspense>
      </div>

      <Section
        numeral="I"
        title="Deploy diff"
        description="What production is missing vs. staging. The big number is the headline answer — use it to decide whether to cut a release today."
      >
        <div className="grid gap-5 md:grid-cols-2">
          <Suspense fallback={<DeployDiffSkeleton title="Inspector" />}>
            <DeployDiff
              title="Inspector"
              owner="MCPJam"
              repo="inspector"
              stagingEnvironment="staging"
              productionEnvironment="production"
              repoUrl="https://github.com/MCPJam/inspector"
            />
          </Suspense>
          <Suspense fallback={<DeployDiffSkeleton title="Backend" />}>
            <DeployDiff
              title="Backend"
              owner="MCPJam"
              repo="mcpjam-backend"
              stagingEnvironment="backend-staging"
              productionEnvironment="backend-production"
              repoUrl="https://github.com/MCPJam/mcpjam-backend"
            />
          </Suspense>
        </div>
      </Section>

      <Section
        numeral="II"
        title="Release readiness"
        description="Checks that mirror release.yml's preflight gates. Green across the board means the Release workflow will pass preflight."
      >
        <Suspense fallback={<ReleaseReadinessSkeleton />}>
          <ReleaseReadiness />
        </Suspense>
      </Section>

      <Section
        numeral="III"
        title="Release preview & dispatch"
        description="What Release would publish from main right now, and the one button that sends it."
      >
        <div className="grid gap-5 md:grid-cols-2">
          <Suspense fallback={<ReleaseDryRunSkeleton />}>
            <ReleaseDryRun />
          </Suspense>
          <RunRelease />
        </div>
      </Section>

      <Section
        numeral="IV"
        title="Release progress"
        description="In-flight release.yml run with a per-job stepper. Polls every 10s while a run is live."
      >
        <Suspense fallback={<ReleaseProgressSkeleton />}>
          <ReleaseProgress />
        </Suspense>
      </Section>

      <Section
        numeral="V"
        title="Recent failures"
        description="Most recent failure per deploy workflow (last 7 days). Check-run annotations inline so you don't have to open GH Actions."
      >
        <Suspense fallback={<DeployFailuresSkeleton />}>
          <DeployFailures />
        </Suspense>
      </Section>

      <footer className="mt-20 border-t border-ink-800/60 pt-6 text-[11px] text-ink-500 md:flex md:items-center md:justify-between">
        <div>
          <span className="font-mono">@mcpjam/soundcheck</span> — private
          workspace · deploys independently · never published.
        </div>
        <div className="mt-2 md:mt-0">
          <a
            href="https://github.com/MCPJam/inspector/tree/main/soundcheck"
            target="_blank"
            rel="noreferrer"
            className="hover:text-ink-200"
          >
            source ↗
          </a>
          <span className="mx-2 text-ink-700">·</span>
          <a
            href="https://github.com/MCPJam/inspector/actions/workflows/release.yml"
            target="_blank"
            rel="noreferrer"
            className="hover:text-ink-200"
          >
            release.yml ↗
          </a>
        </div>
      </footer>
    </main>
  );
}
