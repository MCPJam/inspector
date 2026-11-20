import { useEffect, useState } from "react";
import { listServerSubmissions } from "@/lib/apis/directory-submissions-api";
import {
  publicationBadge,
  readPublicationEvents,
} from "./marketplace-publication";
import { ArrowRight } from "lucide-react";

export type Marketplace = "claude" | "openai";

export function MarketplaceCards({
  projectId,
  serverId,
  onSelect,
}: {
  projectId: string;
  serverId?: string;
  onSelect: (marketplace: Marketplace) => void;
}) {
  const [badges, setBadges] = useState<
    Partial<Record<Marketplace, ReturnType<typeof publicationBadge>>>
  >({});
  useEffect(() => {
    const abort = new AbortController();
    const unavailable = {
      label: "Status unavailable",
      color: "bg-muted-foreground",
    };
    async function read() {
      const submissions = await listServerSubmissions(
        projectId,
        serverId,
        abort.signal,
      );
      const sorted = [...submissions].sort((a, b) => b.updatedAt - a.updatedAt);
      await Promise.all(
        (["claude", "openai"] as const).map(async (directory) => {
          const selected = sorted.find((s) => s.directory === directory);
          if (!selected) return;
          const badge = await readPublicationEvents(
            { projectId, submissionId: selected.id },
            abort.signal,
          ).then(publicationBadge, () => unavailable);
          if (!abort.signal.aborted)
            setBadges((prev) => ({ ...prev, [directory]: badge }));
        }),
      );
    }
    read().catch(() => {
      if (!abort.signal.aborted)
        setBadges({ claude: unavailable, openai: unavailable });
    });
    return () => abort.abort();
  }, [projectId, serverId]);
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-4xl space-y-8 px-6 py-10 sm:px-10">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-card-foreground">
            Readiness
          </h1>
          <p className="text-sm text-muted-foreground">
            Choose a marketplace to review your submission.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["claude", "Claude", "/claude_logo.png"],
              ["openai", "ChatGPT", "/openai_logo.png"],
            ] as const
          ).map(([id, name, logo]) => (
            <button
              key={id}
              type="button"
              aria-label={name}
              aria-describedby={`marketplace-${id}-status`}
              onClick={() => onSelect(id)}
              className="group flex min-h-36 flex-col items-start rounded-lg border border-border bg-card p-6 text-left text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex w-full items-center gap-3 text-lg font-semibold">
                <img
                  src={logo}
                  alt=""
                  className="size-8 rounded-md object-contain"
                />
                {name}
                <ArrowRight
                  aria-hidden="true"
                  className="ml-auto size-4 text-muted-foreground"
                />
              </span>
              <span id={`marketplace-${id}-status`} title="Recorded status of the most recently edited submission" className="mt-auto flex items-center gap-2 pt-6 text-sm text-muted-foreground">
                <span
                  aria-hidden="true"
                  className={`size-2 rounded-full ${badges[id]?.color ?? "bg-muted-foreground"}`}
                />
                {badges[id]?.label ?? "Status unknown"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
