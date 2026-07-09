import { useState } from "react";
import { toast } from "@/lib/toast";
import { Loader2, Plus } from "lucide-react";
import { useAppNavigate, buildHostsPath } from "@/lib/app-navigation";
import { useHostMutations } from "@/hooks/useClients";
import {
  getHostTemplateLogoSrc,
  HOST_TEMPLATES,
  type HostTemplateId,
} from "@/lib/client-templates";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { getCatalogHost, getCatalogTemplate } from "@mcpjam/sdk/host-compat";

const RECOMMENDED_HOST_IDS: readonly HostTemplateId[] = [
  "claude",
  "chatgpt",
  "cursor",
];

interface RecommendedHostsProps {
  projectId: string | null;
}

function cloneHostTemplateInput(value: unknown): HostConfigInputV2 {
  return JSON.parse(JSON.stringify(value)) as HostConfigInputV2;
}

export function RecommendedHosts({ projectId }: RecommendedHostsProps) {
  const { createHost } = useHostMutations();
  const navigate = useAppNavigate();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const catalogState = useHostCatalog();
  const [creatingId, setCreatingId] = useState<HostTemplateId | null>(null);

  const recommended = HOST_TEMPLATES.filter((t) =>
    RECOMMENDED_HOST_IDS.includes(t.id)
  );

  async function handleCreate(templateId: HostTemplateId) {
    if (!projectId) {
      toast.error("Select a project before creating a host.");
      return;
    }
    const catalog =
      catalogState.status === "live" ? catalogState.catalog : null;
    const template = catalog
      ? getCatalogTemplate(catalog, templateId)
      : undefined;
    if (!template) {
      toast.error("Could not load live host templates.");
      return;
    }
    const label =
      (catalog ? getCatalogHost(catalog, templateId)?.label : undefined) ??
      HOST_TEMPLATES.find((t) => t.id === templateId)?.label ??
      templateId;
    setCreatingId(templateId);
    try {
      const seed = cloneHostTemplateInput(template);
      const { hostId } = await createHost({
        projectId,
        name: label,
        input: { ...seed, serverIds: [] },
      });
      toast.success(`Created ${label} host.`);
      navigate(buildHostsPath(hostId));
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
        <h2 className="text-[13px] font-medium text-foreground">
          Recommended clients
        </h2>
      </div>

      <ul>
        {recommended.map((template, i) => {
          const isCreating = creatingId === template.id;
          const isLast = i === recommended.length - 1;
          const catalogHost =
            catalogState.status === "live"
              ? getCatalogHost(catalogState.catalog, template.id)
              : undefined;
          const templateLabel = catalogHost?.label ?? template.label;
          const canCreateFromLiveTemplate =
            catalogState.status === "live" &&
            getCatalogTemplate(catalogState.catalog, template.id) !==
              undefined;
          return (
            <li
              key={template.id}
              className={isLast ? "" : "border-b border-border/40"}
            >
              <button
                type="button"
                disabled={
                  isCreating || !projectId || !canCreateFromLiveTemplate
                }
                onClick={() => handleCreate(template.id)}
                title={
                  canCreateFromLiveTemplate
                    ? `Create ${templateLabel}`
                    : "Live host template unavailable"
                }
                className="group flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="grid size-6 shrink-0 place-items-center rounded bg-muted/60">
                  <img
                    src={getHostTemplateLogoSrc(template, themeMode)}
                    alt=""
                    className="size-3.5 object-contain"
                  />
                </div>
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {templateLabel}
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
