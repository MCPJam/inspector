import { useState } from "react";
import { toast } from "sonner";
import { Loader2, MonitorSmartphone, Plus, ArrowRight } from "lucide-react";
import { Card } from "@mcpjam/design-system/card";
import { useAppNavigate, buildClientsPath } from "@/lib/app-navigation";
import { useHostMutations } from "@/hooks/useClients";
import {
  HOST_TEMPLATES,
  seedFromHostTemplate,
  type HostTemplateId,
} from "@/lib/client-templates";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

const RECOMMENDED_CLIENT_IDS: readonly HostTemplateId[] = [
  "claude",
  "chatgpt",
  "cursor",
];

const TEMPLATE_ACCENT: Partial<Record<HostTemplateId, string>> = {
  claude:
    "bg-gradient-to-br from-orange-100 to-amber-50 ring-orange-200/40 dark:from-orange-500/15 dark:to-amber-500/10 dark:ring-orange-400/15",
  chatgpt:
    "bg-gradient-to-br from-emerald-100 to-teal-50 ring-emerald-200/40 dark:from-emerald-500/15 dark:to-teal-500/10 dark:ring-emerald-400/15",
  cursor:
    "bg-gradient-to-br from-slate-200/80 to-slate-50 ring-slate-300/30 dark:from-slate-500/15 dark:to-slate-700/10 dark:ring-slate-400/15",
};

interface RecommendedClientsProps {
  projectId: string | null;
}

export function RecommendedClients({ projectId }: RecommendedClientsProps) {
  const { createHost } = useHostMutations();
  const navigate = useAppNavigate();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [creatingId, setCreatingId] = useState<HostTemplateId | null>(null);

  const recommended = HOST_TEMPLATES.filter((t) =>
    RECOMMENDED_CLIENT_IDS.includes(t.id),
  );

  async function handleCreate(templateId: HostTemplateId, label: string) {
    if (!projectId) {
      toast.error("Select a project before creating a client.");
      return;
    }
    setCreatingId(templateId);
    try {
      const seed = seedFromHostTemplate(templateId, { theme: themeMode });
      const { hostId } = await createHost({
        projectId,
        name: label,
        input: { ...seed, serverIds: [] },
      });
      toast.success(`Created ${label} client.`);
      navigate(buildClientsPath(hostId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to create ${label}: ${message}`);
    } finally {
      setCreatingId(null);
    }
  }

  return (
    <Card className="overflow-hidden border-foreground/[0.06] bg-card/95 shadow-[0_1px_2px_rgba(20,14,4,0.025),0_12px_32px_-16px_rgba(20,14,4,0.07)] dark:border-foreground/[0.08] dark:bg-card/80 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-16px_rgba(0,0,0,0.6)]">
      <div className="px-6 pt-5">
        <div className="flex items-center gap-2.5">
          <MonitorSmartphone className="h-4 w-4 text-foreground/45" />
          <h3 className="text-[15px] font-semibold tracking-[-0.005em]">
            Recommended clients
          </h3>
        </div>
        <p className="mt-1 text-[12.5px] text-foreground/55">
          Spin up a sandbox client to test how your servers behave.
        </p>
      </div>

      <ul className="px-3 pb-3 pt-3">
        {recommended.map((template, i) => {
          const isCreating = creatingId === template.id;
          const accent =
            TEMPLATE_ACCENT[template.id] ??
            "bg-gradient-to-br from-stone-100 to-stone-50 ring-stone-200/40 dark:from-stone-500/15 dark:to-stone-700/10";
          const isLast = i === recommended.length - 1;
          return (
            <li
              key={template.id}
              className={`group relative ${isLast ? "" : "border-b border-foreground/[0.05]"}`}
            >
              <button
                type="button"
                disabled={isCreating || !projectId}
                onClick={() => handleCreate(template.id, template.label)}
                className="flex w-full items-center gap-3.5 rounded-xl px-3 py-3.5 text-left transition-colors hover:bg-foreground/[0.025] disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-foreground/[0.04]"
              >
                <div
                  className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset ${accent}`}
                >
                  <img
                    src={template.logoSrc}
                    alt=""
                    className="h-5 w-5 object-contain"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium tracking-[-0.005em]">
                    {template.label}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-[12.5px] text-foreground/55">
                    {template.description}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-foreground/55 transition-all group-hover:text-foreground group-hover:gap-1.5 group-disabled:opacity-50">
                  {isCreating ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Creating
                    </>
                  ) : (
                    <>
                      <Plus className="h-3.5 w-3.5" />
                      Create
                      <ArrowRight className="h-3 w-3 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
