import { useState } from "react";
import { toast } from "@/lib/toast";
import { Loader2, Plus } from "lucide-react";
import { useAppNavigate, buildHostsPath } from "@/lib/app-navigation";
import { useHostMutations } from "@/hooks/useClients";
import { cloneHostTemplateInput } from "@/lib/client-config-v2";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { getCatalogHost, getCatalogTemplate } from "@mcpjam/sdk/host-compat";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";

const RECOMMENDED_HOST_IDS = ["claude", "chatgpt", "cursor"] as const;

interface RecommendedHostsProps {
  projectId: string | null;
}

export function RecommendedHosts({ projectId }: RecommendedHostsProps) {
  const { createHost } = useHostMutations();
  const navigate = useAppNavigate();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const catalogState = useHostCatalog();
  const [creatingId, setCreatingId] = useState<string | null>(null);

  const recommended =
    catalogState.status === "live"
      ? RECOMMENDED_HOST_IDS.flatMap((id) => {
          const host = getCatalogHost(catalogState.catalog, id);
          return host ? [host] : [];
        })
      : [];

  async function handleCreate(hostId: string) {
    if (!projectId) {
      toast.error("Select a project before creating a client.");
      return;
    }
    const catalog =
      catalogState.status === "live" ? catalogState.catalog : null;
    const template = catalog
      ? getCatalogTemplate(catalog, hostId)
      : undefined;
    if (!template) {
      toast.error("Could not load live client templates.");
      return;
    }
    const label =
      (catalog ? getCatalogHost(catalog, hostId)?.label : undefined) ?? hostId;
    setCreatingId(hostId);
    try {
      const seed = cloneHostTemplateInput(template, { themeMode });
      const { hostId } = await createHost({
        projectId,
        name: label,
        input: { ...seed, serverIds: [] },
      });
      toast.success(`Created ${label} client.`);
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
        {recommended.map((host, i) => {
          const isCreating = creatingId === host.id;
          const isLast = i === recommended.length - 1;
          const canCreateFromLiveTemplate =
            catalogState.status === "live" &&
            getCatalogTemplate(catalogState.catalog, host.id) !== undefined;
          return (
            <li
              key={host.id}
              className={isLast ? "" : "border-b border-border/40"}
            >
              <button
                type="button"
                disabled={
                  isCreating || !projectId || !canCreateFromLiveTemplate
                }
                onClick={() => handleCreate(host.id)}
                title={
                  canCreateFromLiveTemplate
                    ? `Create ${host.label}`
                    : "Live client template unavailable"
                }
                className="group flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="grid size-6 shrink-0 place-items-center rounded bg-muted/60">
                  <img
                    src={getHostLogoSrc(host.id, themeMode)}
                    alt=""
                    className="size-3.5 object-contain"
                  />
                </div>
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {host.label}
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
