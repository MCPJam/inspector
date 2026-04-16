import { Suspense } from "react";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { isAllowedEmployeeEmail, isLockdownEnabled } from "@/lib/lockdown";
import {
  DeployDiff,
  DeployDiffSkeleton
} from "@/components/deploy-diff";

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

      <section className="mb-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Deploy diff
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          What production is missing vs. staging. Use this to decide whether
          to cut a release.
        </p>
      </section>

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
    </main>
  );
}
