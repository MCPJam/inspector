import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { ErrorBoundary } from "@/components/ui/error-boundary";

interface Usage {
  totalCredits: number;
  daily: { date: string; credits: number }[];
  features: { name: string; credits: number }[];
  truncated: boolean;
}
export function CreditUsagePage() {
  return (
    <ErrorBoundary
      name="credit_usage"
      fallback={() => (
        <p role="alert">Credit usage is unavailable. Please try again later.</p>
      )}
    >
      <CreditUsageDashboard />
    </ErrorBoundary>
  );
}
function CreditUsageDashboard() {
  const { orgId } = useParams();
  const ready = useDbUserReady();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const usage = useQuery(
    "billing/creditUsage:getOrganizationCreditUsage" as any,
    ready && orgId ? { organizationId: orgId, days } : "skip",
  ) as Usage | undefined;
  const max = Math.max(1, ...(usage?.daily.map((day) => day.credits) ?? []));
  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Credits usage</h1>
          <SettingsPageDescription>
            View your organization’s credit consumption over time.
          </SettingsPageDescription>
        </div>
        <select
          aria-label="Usage period"
          className="rounded-md border border-input bg-background p-2 text-sm"
          value={days}
          onChange={(event) =>
            setDays(Number(event.target.value) as 7 | 30 | 90)
          }
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </header>
      {!usage ? (
        <p role="status">Loading usage…</p>
      ) : (
        <>
          {usage.truncated && (
            <p role="status">
              Showing the latest 10,000 transactions. Choose a shorter period
              for complete totals.
            </p>
          )}
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="border-b border-border p-5">
              <p className="text-sm text-muted-foreground">Credits consumed</p>
              <p className="mt-1 text-2xl font-semibold">
                {usage.totalCredits.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </p>
            </div>
            <figure className="p-5">
              <figcaption className="mb-4 text-sm font-medium">
                Daily usage · UTC
              </figcaption>
              <div
                className="flex h-48 items-end gap-1 border-b border-border"
                role="img"
                aria-label={`Daily credit consumption over the last ${days} days. Details in the daily breakdown below.`}
              >
                {usage.daily.map((day) => (
                  <div
                    key={day.date}
                    className="flex h-full min-w-0 flex-1 items-end"
                    title={`${
                      day.date
                    }: ${day.credits.toLocaleString()} credits`}
                  >
                    <div
                      className="w-full rounded-t-sm bg-primary"
                      style={{ height: `${(day.credits / max) * 100}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                <span>{usage.daily[0]?.date}</span>
                <span>{usage.daily.at(-1)?.date}</span>
              </div>
            </figure>
          </div>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Usage by feature</h2>
            <p className="text-xs text-muted-foreground">
              Historical model calls may be grouped together. Includes recorded
              credit debits; free daily usage is excluded.
            </p>
            {usage.features.length === 0 ? (
              <p>No credit consumption in this period.</p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {usage.features.map((feature) => (
                  <div
                    key={feature.name}
                    className="flex justify-between p-3 text-sm"
                  >
                    <span>{feature.name}</span>
                    <span>
                      {feature.credits.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}{" "}
                      credits
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Daily breakdown
            </summary>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left">Date (UTC)</th>
                  <th className="text-right">Credits</th>
                </tr>
              </thead>
              <tbody>
                {usage.daily.map((day) => (
                  <tr key={day.date} className="border-t border-border">
                    <td className="py-2">{day.date}</td>
                    <td className="text-right">
                      {day.credits.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}
