import { Suspense } from "react";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { isAllowedEmployeeEmail, isLockdownEnabled } from "@/lib/lockdown";
import {
  DeployDiff,
  DeployDiffSkeleton
} from "@/components/deploy-diff";
import {
  ReleaseProgress,
  ReleaseProgressSkeleton
} from "@/components/release-progress";
import {
  McpDeployStatus,
  McpDeployStatusSkeleton
} from "@/components/mcp-deploy-status";
import { ReleaseCard, ReleaseCardSkeleton } from "@/components/release-card";
import { Section } from "@/components/ui";
import { Card, CardContent } from "@mcpjam/design-system/card";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { user } = await withAuth({ ensureSignedIn: true });

  if (isLockdownEnabled() && !isAllowedEmployeeEmail(user.email)) {
    return (
      <main className="mx-auto max-w-xl px-6 py-24">
        <Card className="border-l-4 border-l-destructive py-6">
          <CardContent>
            <h1 className="text-3xl font-semibold text-foreground">
              Not authorized.
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Soundcheck is restricted to MCPJam employees. If you think this is
              a mistake, reach out in{" "}
              <span className="font-mono text-foreground">#ops</span>.
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-12 md:px-8 md:py-16">
      <header className="mb-10 flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          Soundcheck<span className="text-primary">.</span>
        </h1>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {user.email}
        </span>
      </header>

      <Suspense fallback={<ReleaseCardSkeleton />}>
        <ReleaseCard />
      </Suspense>

      <Section id="steps" title="Steps" description="The current or last release run.">
        <Suspense fallback={<ReleaseProgressSkeleton />}>
          <ReleaseProgress />
        </Suspense>
      </Section>

      <Section title="Services" description="What is live where.">
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
          <Suspense fallback={<McpDeployStatusSkeleton />}>
            <McpDeployStatus />
          </Suspense>
        </div>
      </Section>

      <footer className="mt-20 flex gap-4 border-t border-border pt-6 text-xs text-muted-foreground">
        <a
          href="https://github.com/MCPJam/inspector/tree/main/soundcheck"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground"
        >
          Source
        </a>
        <a
          href="https://github.com/MCPJam/inspector/actions/workflows/release.yml"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground"
        >
          Release runs
        </a>
      </footer>
    </main>
  );
}
