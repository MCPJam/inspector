import { withAuth } from "@workos-inc/authkit-nextjs";
import { isAllowedEmployeeEmail, isLockdownEnabled } from "@/lib/lockdown";

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
    <main className="p-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Soundcheck</h1>
        <p className="text-sm text-neutral-500">
          Signed in as {user.email}
        </p>
      </header>

      <section className="rounded-lg border border-neutral-200 p-6">
        <h2 className="text-sm font-medium text-neutral-700">
          Scaffold only
        </h2>
        <p className="mt-2 text-sm text-neutral-500">
          Deploy-diff, release readiness, release progress stepper, and drift
          alerts land in follow-up commits. See{" "}
          <code>soundcheck/README.md</code> for the feature list.
        </p>
      </section>
    </main>
  );
}
