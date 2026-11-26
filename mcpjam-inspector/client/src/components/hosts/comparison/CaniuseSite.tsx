import { useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { getScenarioHostLogo } from "@/lib/scenario-client-style";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import { routePaths } from "@/lib/app-navigation";
import { useServerSupportsFeature } from "@/lib/server-capabilities";
import { NotifyButton, ReportInconsistencyDialog } from "./HostConfigCompareView";
import "./caniuse-site.css";

export const CANIUSE_CAPABILITIES_HOME = "/capabilities/event-delivery";

export function clientLogo(subject: HostComparisonSubject) {
  return getScenarioHostLogo(
    subject.hostStyle,
    subject.config.chatUiOverride,
    "dark",
  );
}

export function CaniuseSite({
  current,
  children,
}: {
  current: "compare" | "capabilities";
  children: ReactNode;
}) {
  const publicSiteRelays = useServerSupportsFeature("public-site-relays");
  const scroller = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [pathname]);

  return (
    <div
      ref={scroller}
      className="dark caniuse-site flex h-full min-w-0 flex-col overflow-auto bg-background text-foreground"
      data-page={current}
    >
      <header className="shrink-0 border-b border-border/65 bg-inherit">
        <div className="caniuse-wrap flex h-16 items-center gap-5 sm:gap-8">
          <a
            className="caniuse-brand rounded-md focus-visible:outline-2 focus-visible:outline-ring"
            href="https://www.mcpjam.com/"
            aria-label="MCPJam"
          >
            <img
              alt=""
              src="/caniuse-jar.webp"
              width="36"
              height="40"
              className="h-10 w-9 object-contain"
            />
          </a>
          <nav
            aria-label="Can I use MCP"
            className="flex h-full items-stretch gap-5 text-sm sm:gap-7"
          >
            <Link
              to={routePaths.caniuseCompare}
              aria-current={current === "compare" ? "page" : undefined}
              className="caniuse-nav-link"
            >
              Compare
            </Link>
            <Link
              to={CANIUSE_CAPABILITIES_HOME}
              aria-current={current === "capabilities" ? "page" : undefined}
              className="caniuse-nav-link"
            >
              Capabilities
            </Link>
          </nav>
        </div>
      </header>
      <main className="caniuse-wrap grow shrink-0 pb-10">{children}</main>
      <footer className="shrink-0 border-t border-border/65 bg-inherit text-muted-foreground">
        <div className="caniuse-wrap flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 py-3">
          {publicSiteRelays !== false && (
            <>
              <ReportInconsistencyDialog footer />
              <NotifyButton footer />
            </>
          )}
          <a
            href="https://www.mcpjam.com/"
            aria-label="By MCPJam"
            className="ml-auto inline-flex items-center gap-1.5 rounded-sm text-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span>By</span>
            <img src="/mcp_jam_dark.png" alt="" width="84" height="14" />
          </a>
        </div>
      </footer>
    </div>
  );
}
