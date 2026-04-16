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
import { Section } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { user } = await withAuth({ ensureSignedIn: true });

  if (isLockdownEnabled() && !isAllowedEmployeeEmail(user.email)) {
    return (
      <main className="p-8">
        <h1 className="text-xl font-semibold">Not authorized</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Soundcheck is restricted to MCPJam employees.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Soundcheck</h1>
        <p className="text-sm text-neutral-500">
          Signed in as {user.email}
        </p>
      </header>

      <Section
        title="Deploy diff"
        description="What production is missing vs. staging. Use this to decide whether to cut a release."
      >
        <div className="grid gap-4 md:grid-cols-2">
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
        title="Release readiness"
        description="Checks that mirror release.yml's preflight gates. Green across the board means the Release workflow will pass preflight."
      >
        <Suspense fallback={<ReleaseReadinessSkeleton />}>
          <ReleaseReadiness />
        </Suspense>
      </Section>

      <Section
        title="Release preview & dispatch"
        description="What Release would publish from main right now, and the button to dispatch it."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Suspense fallback={<ReleaseDryRunSkeleton />}>
            <ReleaseDryRun />
          </Suspense>
          <RunRelease />
        </div>
      </Section>

      <Section
        title="Release progress"
        description="In-flight release.yml run, with a per-job stepper. Polls every 10s while a run is live."
      >
        <Suspense fallback={<ReleaseProgressSkeleton />}>
          <ReleaseProgress />
        </Suspense>
      </Section>

      <Section
        title="Recent failures"
        description="Most recent failure per deploy workflow (last 7 days). Check-run annotations inline so you don't have to open GH Actions."
      >
        <Suspense fallback={<DeployFailuresSkeleton />}>
          <DeployFailures />
        </Suspense>
      </Section>
    </main>
  );
}
