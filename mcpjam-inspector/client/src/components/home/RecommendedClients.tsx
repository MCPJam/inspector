import { useState } from "react";
import { toast } from "sonner";
import { Loader2, MonitorSmartphone, Plus, ArrowRight } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@mcpjam/design-system/card";
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
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="px-6 pb-3 pt-5">
        <CardTitle className="flex items-center gap-2 text-[15px] tracking-[-0.005em]">
          <MonitorSmartphone className="size-4 text-muted-foreground" strokeWidth={1.75} />
          Recommended clients
        </CardTitle>
        <CardDescription className="text-[12.5px]">
          Spin up a sandbox client to test how your servers behave.
        </CardDescription>
      </CardHeader>

      <CardContent className="px-3 pb-3 pt-1">
        <ul>
          {recommended.map((template, i) => {
            const isCreating = creatingId === template.id;
            const isLast = i === recommended.length - 1;
            return (
              <li
                key={template.id}
                className={`relative ${isLast ? "" : "border-b border-border/40"}`}
              >
                <button
                  type="button"
                  disabled={isCreating || !projectId}
                  onClick={() => handleCreate(template.id, template.label)}
                  className="group flex w-full items-center gap-4 rounded-lg px-3 py-3.5 text-left transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted ring-1 ring-inset ring-border/40">
                    <img
                      src={template.logoSrc}
                      alt=""
                      className="size-5 object-contain"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium tracking-[-0.005em] text-foreground">
                      {template.label}
                    </p>
                    <p className="mt-0.5 line-clamp-1 text-[12.5px] text-muted-foreground">
                      {template.description}
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-muted-foreground transition-colors group-hover:text-foreground group-disabled:opacity-50">
                    {isCreating ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        Creating
                      </>
                    ) : (
                      <>
                        <Plus className="size-3.5" />
                        Create
                        <ArrowRight className="size-3 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
