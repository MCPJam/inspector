import { ArrowLeft, ChevronRight } from "lucide-react";
import { useAppNavigate, useCurrentLocationParts } from "@/lib/app-navigation";
import { resolveSettingsDestination } from "@/lib/settings-manifest";
import { DestinationIcon } from "./SettingsIcon";
import type { MouseEvent, ReactNode } from "react";

type Crumb = { label: string; icon?: string; href?: string };

/** Only real child routes become breadcrumbs; search targets remain page sections. */
export function settingsBreadcrumbs(pathname: string, search = ""): Crumb[] {
  const destination = resolveSettingsDestination(pathname);
  if (!destination) return [];
  const root: Crumb = { label: destination.label, icon: destination.id };
  if (destination.id === "org-byok" && pathname.endsWith("/models/usage")) {
    return [
      { ...root, href: pathname.replace(/\/usage$/, "") },
      { label: "Usage" },
    ];
  }
  if (destination.id === "org-billing" && pathname.endsWith("/billing/usage"))
    return [
      { ...root, href: pathname.replace(/\/usage$/, "") },
      { label: "Credits usage" },
    ];
  if (destination.id !== "org-integrations") return [root];

  const query = new URLSearchParams(search);
  query.delete("setting");
  const suffix = query.size ? `?${query}` : "";
  const organization = pathname.match(
    /^\/organizations\/([^/]+)\/(slack|discord|observability)$/,
  );
  if (organization) {
    root.href = `/organizations/${organization[1]}/integrations${suffix}`;
    const labels: Record<string, string> = {
      slack: "Slack",
      discord: "Discord",
      observability: "Observability",
    };
    return [root, { label: labels[organization[2]] }];
  }
  if (
    pathname === "/settings/integrations/github" ||
    pathname === "/settings/integrations/github/callback"
  ) {
    root.href = `/settings/integrations${suffix}`;
    const github: Crumb = { label: "GitHub Checks" };
    if (pathname.endsWith("/callback")) {
      github.href = `/settings/integrations/github${suffix}`;
      return [root, github, { label: "Installation" }];
    }
    return [root, github];
  }
  return [root];
}

export function SettingsContentFrame({ children }: { children: ReactNode }) {
  const location = useCurrentLocationParts();
  const navigate = useAppNavigate();
  const crumbs = settingsBreadcrumbs(location.pathname, location.search);
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : undefined;
  const follow = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {crumbs.length > 0 && (
        <nav
          aria-label="Settings breadcrumb"
          className="flex min-h-12 shrink-0 items-center border-b border-border bg-background px-4 text-sm text-accent-foreground"
        >
          <ol className="flex min-w-0 flex-wrap items-center gap-2 py-2">
            {crumbs.map((crumb, index) => (
              <li key={crumb.label} className="flex min-w-0 items-center gap-2">
                {index > 0 && (
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-foreground"
                  />
                )}
                {crumb.href ? (
                  <a
                    href={crumb.href}
                    onClick={(event) => follow(event, crumb.href!)}
                    className="flex items-center gap-2 rounded-sm text-foreground hover:text-accent-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {crumb.icon && <DestinationIcon id={crumb.icon} />}
                    {crumb.label}
                  </a>
                ) : (
                  <span
                    aria-current="page"
                    className="flex items-center gap-2 font-medium"
                  >
                    {crumb.icon && <DestinationIcon id={crumb.icon} />}
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div
        id="settings-content"
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto outline-none"
      >
        <div className="mx-auto w-full max-w-5xl space-y-8 p-4 md:p-10">
          {parent?.href && (
            <a
              href={parent.href}
              onClick={(event) => follow(event, parent.href!)}
              className="inline-flex items-center gap-2 rounded-sm text-sm font-medium text-foreground hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              Back to {parent.label}
            </a>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
