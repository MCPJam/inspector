import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
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
    <section className="rounded-xl border border-border/60">
      <div className="border-b border-border/60 px-4 py-2">
        <h2 className="text-[13px] font-medium text-foreground">Recommended clients</h2>
      </div>

      <ul>
        {recommended.map((template, i) => {
          const isCreating = creatingId === template.id;
          const isLast = i === recommended.length - 1;
          return (
            <li key={template.id} className={isLast ? "" : "border-b border-border/40"}>
              <button
                type="button"
                disabled={isCreating || !projectId}
                onClick={() => handleCreate(template.id, template.label)}
                className="group flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="grid size-6 shrink-0 place-items-center rounded bg-muted/60">
                  <img
                    src={template.logoSrc}
                    alt=""
                    className="size-3.5 object-contain"
                  />
                </div>
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {template.label}
                </span>
                <span className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-muted-foreground transition group-hover:text-foreground group-disabled:opacity-50">
                  {isCreating ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <>
                      <Plus className="size-3" />
                      Create
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
