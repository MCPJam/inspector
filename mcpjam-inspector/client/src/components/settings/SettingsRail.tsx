import { SettingsContextPicker } from "./SettingsContextPicker";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { DestinationIcon } from "./SettingsIcon";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { useAppNavigate, useCurrentLocationParts } from "@/lib/app-navigation";
import { buildProjectPath, isProjectIdShape } from "@/lib/project-route";
import {
  resolveSettingsDestination,
  searchSettings,
  settingsBackTarget,
  settingsPath,
  visibleSettings,
  type SettingsContext,
  type SettingsReturnLocation,
} from "@/lib/settings-manifest";

interface Props {
  enabled: boolean;
  context: SettingsContext;
  organizations: readonly { _id: string; name: string }[];
  projects: readonly {
    id: string;
    name: string;
    organizationId?: string;
    remoteProject?: boolean;
  }[];
  defaultHub: string;
  onSwitchLocalProject?: (projectId: string) => Promise<void>;
}
function focusDestination(target?: string) {
  const node =
    (target && document.getElementById(`setting-${target}`)) ||
    document.getElementById("settings-content");
  if (node) {
    node.setAttribute("tabindex", "-1");
    node.focus({ preventScroll: true });
    if (target) node.scrollIntoView?.({ block: "start" });
  }
}
export function SettingsRail({
  enabled,
  context,
  organizations,
  projects,
  defaultHub,
  onSwitchLocalProject,
}: Props) {
  const navigate = useAppNavigate();
  const location = useCurrentLocationParts();
  const previous = useRef<SettingsReturnLocation | null>(null);
  const restored = useRef(false);
  if (!restored.current) {
    restored.current = true;
    try {
      const value = JSON.parse(
        sessionStorage.getItem("mcpjam.settings.return") ?? "null",
      );
      if (value && typeof value.path === "string") previous.current = value;
    } catch {
      /* Storage is optional. */
    }
  }
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const destination = resolveSettingsDestination(location.pathname);
  const results = searchSettings(query, context);
  const entries = visibleSettings(context);
  const scopedProjects = projects.filter(
    (p) => p.organizationId === context.organizationId,
  );
  useEffect(() => {
    if (!enabled) {
      previous.current = {
        path: location.pathname + location.search + location.hash,
        organizationId: context.organizationId,
        projectId: context.projectId,
      };
      try {
        sessionStorage.setItem(
          "mcpjam.settings.return",
          JSON.stringify(previous.current),
        );
      } catch {
        /* Private browsing may disable storage. */
      }
    }
  }, [
    enabled,
    location.pathname,
    location.search,
    location.hash,
    context.organizationId,
    context.projectId,
  ]);
  useEffect(() => {
    if (!enabled) return;
    if (
      location.pathname.endsWith("/billing") &&
      new URLSearchParams(location.search).get("plans") === "open"
    ) {
      navigate(
        location.pathname.replace(/\/billing$/, "/plans") +
          location.search +
          location.hash,
        { replace: true },
      );
      return;
    }
    if (location.pathname.endsWith("/budget")) {
      const params = new URLSearchParams(location.search);
      params.set("setting", "spend-budget");
      navigate(
        location.pathname.replace(/\/budget$/, "/billing") +
          `?${params}` +
          location.hash,
        { replace: true },
      );
      return;
    }
    setQuery("");
    const target =
      new URLSearchParams(location.search).get("setting") ?? undefined;
    // Wait for async sections (organization bootstrap, billing) as well as the route commit.
    let focused = false;
    const observer = new MutationObserver(() => {
      if (target && document.getElementById(`setting-${target}`)) {
        focusDestination(target);
        focused = true;
        observer.disconnect();
      }
    });
    if (target)
      observer.observe(document.body, { childList: true, subtree: true });
    const frame = requestAnimationFrame(() => {
      if (!focused) focusDestination(target);
      if (!target || document.getElementById(`setting-${target}`))
        observer.disconnect();
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [enabled, location.pathname, location.search]);
  if (!enabled) return null;

  const select = (id: string, target?: string) => {
    navigate(
      settingsPath(id, context, location.search, target) + location.hash,
    );
  };
  const navigation = (prefix: string) => (
    <>
      <div className="mb-3 flex shrink-0 items-center gap-2 px-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to app"
          title="Back to app"
          className="size-8 shrink-0"
          onClick={() =>
            navigate(
              settingsBackTarget(
                previous.current,
                context,
                buildProjectPath(context.projectId ?? "", `/${defaultHub}`),
              ),
            )
          }
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold text-accent-foreground">
          Settings
        </h1>
      </div>
      <div className="relative mx-2 shrink-0">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-foreground"
        />
        <Input
          className="h-8 pl-9 text-foreground placeholder:text-foreground/70"
          aria-label="Search settings"
          placeholder="Search settings…"
          role="combobox"
          aria-expanded={!!query}
          aria-controls={`${prefix}-settings-search-results`}
          aria-activedescendant={
            query && results[selected]
              ? `${prefix}-settings-result-${selected}`
              : undefined
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              e.stopPropagation();
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((i) =>
                results.length
                  ? (i + (e.key === "ArrowDown" ? 1 : -1) + results.length) %
                    results.length
                  : 0,
              );
            }
            if (e.key === "Enter" && results[selected]) {
              e.preventDefault();
              select(
                results[selected].destination.id,
                results[selected].target,
              );
            }
          }}
        />
      </div>
      {query ? (
        <div
          id={`${prefix}-settings-search-results`}
          role="listbox"
          aria-label="Settings results"
          className="mt-2 min-h-0 flex-1 overflow-y-auto space-y-1"
        >
          {!results.length && (
            <p role="status" className="px-3 py-3 text-sm text-muted-foreground">
              No settings found.
            </p>
          )}
          {results.map((r, i) => (
            <button
              key={`${r.destination.id}-${r.target ?? "page"}`}
              id={`${prefix}-settings-result-${i}`}
              role="option"
              aria-selected={i === selected}
              onClick={() => select(r.destination.id, r.target)}
              className={`w-full rounded-md px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring ${
                i === selected
                  ? "bg-background font-medium text-foreground shadow-[inset_0_0_0_1px_var(--divider)]"
                  : ""
              }`}
            >
              <span className="flex items-center gap-2">
                <DestinationIcon id={r.destination.id} />
                {r.label}
              </span>
              <span className="text-xs text-foreground/80">
                {r.destination.group} · {r.destination.label}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <nav
          aria-label="Settings sections"
          className="mt-3 min-h-0 flex-1 overflow-y-auto"
        >
          {(["Personal", "Organization", "Project"] as const).map((group) => {
            const items = entries.filter((d) => d.group === group);
            if (!items.length) return null;
            return (
              <div
                key={group}
                className="space-y-0.5 px-2 py-1 [&+div]:mt-1 [&+div]:border-t [&+div]:border-border/50 [&+div]:pt-2"
              >
                <h2 className="flex h-5 items-center text-xs font-medium text-sidebar-foreground/70">
                  {group}
                </h2>
                {group === "Organization" && (
                  <SettingsContextPicker
                    label="Organization"
                    options={organizations.map((o) => ({
                      id: o._id,
                      name: o.name,
                    }))}
                    value={context.organizationId ?? ""}
                    onValueChange={(value) => {
                      const next = {
                        ...context,
                        organizationId: value,
                      };
                      // Organization routes drive the existing organization coordinator; no eager context mutation.
                      navigate(
                        destination?.id === "org-integrations"
                          ? `/organizations/${encodeURIComponent(
                              value,
                            )}/integrations${location.search}${location.hash}`
                          : settingsPath(
                              destination?.group === "Organization"
                                ? destination.id
                                : "org-general",
                              next,
                              location.search,
                            ) + location.hash,
                      );
                    }}
                  />
                )}
                {group === "Project" && (
                  <SettingsContextPicker
                    label="Project"
                    options={scopedProjects}
                    value={
                      scopedProjects.some((p) => p.id === context.projectId)
                        ? context.projectId!
                        : ""
                    }
                    onValueChange={async (value) => {
                      const projectId = value;
                      const next = {
                        ...context,
                        projectId,
                        remoteProject:
                          scopedProjects.find(
                            (project) => project.id === projectId,
                          )?.remoteProject ?? context.remoteProject,
                      };
                      if (
                        !isProjectIdShape(projectId) &&
                        onSwitchLocalProject
                      ) {
                        if (
                          !window.dispatchEvent(
                            new Event("settings-before-navigation", {
                              cancelable: true,
                            }),
                          )
                        )
                          return;
                        await onSwitchLocalProject(projectId);
                      }
                      const equivalent = visibleSettings(next).find(
                        (d) => d.id === destination?.id,
                      );
                      navigate(
                        settingsPath(
                          destination?.group === "Project" && equivalent
                            ? equivalent.id
                            : "project-general",
                          next,
                          location.search,
                        ) + location.hash,
                      );
                    }}
                  />
                )}
                {items.map((d) => (
                  <button
                    key={d.id}
                    aria-current={destination?.id === d.id ? "page" : undefined}
                    onClick={() => select(d.id)}
                    className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md p-2 text-left text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
                      destination?.id === d.id
                        ? "bg-background font-medium text-foreground shadow-[inset_0_0_0_1px_var(--divider)]"
                        : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    }`}
                  >
                    <DestinationIcon id={d.id} />
                    {d.label}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
      )}
    </>
  );
  return (
    <aside
      aria-label="Settings sidebar"
      className="flex h-svh w-64 shrink-0 flex-col overflow-hidden bg-sidebar py-3 text-sidebar-foreground"
    >
      {navigation("settings")}
      <nav
        aria-label="App information"
        className="mx-2 mt-2 shrink-0 border-t border-border/50 pt-2"
      >
        {[{ id: "personal-support", label: "Support" }, { id: "personal-about", label: "About MCPJam" }].map((item) => (
          <button
            key={item.id}
            aria-current={destination?.id === item.id ? "page" : undefined}
            onClick={() => select(item.id)}
            className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md p-2 text-left text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
              destination?.id === item.id
                ? "bg-background font-medium text-foreground shadow-[inset_0_0_0_1px_var(--divider)]"
                : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            }`}
          >
            <DestinationIcon id={item.id} />
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
