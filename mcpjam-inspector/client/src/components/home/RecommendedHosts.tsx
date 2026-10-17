import { useClaudeCodeHostEnabled } from "@/hooks/useClaudeCodeHostEnabled";
import { useCodexHostEnabled } from "@/hooks/useCodexHostEnabled";
import { useState } from "react";
import { Plus } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { useAppNavigate, buildHostsPath } from "@/lib/app-navigation";
import {
  PROJECT_CLIENTS_ADMIN_ONLY_MESSAGE,
  useCanManageProjectClients,
} from "@/hooks/useProjects";
import { CreateHostDialog } from "@/components/hosts/CreateHostDialog";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { getCatalogHost, getCatalogTemplate } from "@mcpjam/sdk/host-compat";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";

const RECOMMENDED_HOST_IDS = ["claude", "chatgpt", "cursor"] as const;

interface RecommendedHostsProps {
  projectId: string | null;
}

export function RecommendedHosts({ projectId }: RecommendedHostsProps) {
  const navigate = useAppNavigate();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const catalogState = useHostCatalog();
  const claudeCodeEnabled = useClaudeCodeHostEnabled();
  const codexEnabled = useCodexHostEnabled();
  const templateIds = [
    ...RECOMMENDED_HOST_IDS,
    ...(claudeCodeEnabled ? ["claude-code"] : []),
    ...(codexEnabled ? ["codex"] : []),
  ];
  const [createTemplateId, setCreateTemplateId] = useState<string | null>(null);
  const { isAuthenticated } = useConvexAuth();
  // Creating a client is project-admin only (`hosts.ts` `requireAdminAccess`).
  const { canManage: canManageClients } = useCanManageProjectClients({
    isAuthenticated,
    projectId,
  });

  const recommended =
    catalogState.status === "live"
      ? templateIds.flatMap((id) => {
          const host = getCatalogHost(catalogState.catalog, id);
          return host ? [host] : [];
        })
      : [];

  return (
    <section className="rounded-xl border border-border/60">
      <div className="border-b border-border/60 px-4 py-2">
        <h2 className="text-[13px] font-medium text-foreground">
          Recommended clients
        </h2>
      </div>

      <ul>
        {recommended.map((host, i) => {
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
                  !projectId ||
                  !canManageClients ||
                  !canCreateFromLiveTemplate
                }
                onClick={() => setCreateTemplateId(host.id)}
                title={
                  !canManageClients
                    ? PROJECT_CLIENTS_ADMIN_ONLY_MESSAGE
                    : canCreateFromLiveTemplate
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
                  <Plus className="size-3" />
                  Create
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {projectId && createTemplateId && (
        <CreateHostDialog
          isOpen
          projectId={projectId}
          initialTemplateId={createTemplateId}
          onClose={() => setCreateTemplateId(null)}
          onCreated={(hostId) => {
            setCreateTemplateId(null);
            navigate(buildHostsPath(hostId));
          }}
        />
      )}
    </section>
  );
}
