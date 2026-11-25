import { useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { getScenarioHostLogo } from "@/lib/scenario-client-style";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import { routePaths } from "@/lib/app-navigation";
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
  const scroller = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [pathname]);

  return (
    <div
      ref={scroller}
      className="dark caniuse-site h-full min-w-0 overflow-auto bg-background text-foreground"
    >
      <div className="mx-auto min-h-full max-w-[1440px] px-4 pb-10 sm:px-8">
        <header className="flex h-16 items-center gap-5 border-b border-border sm:gap-8">
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
            className="flex h-full items-stretch gap-5 text-sm font-semibold sm:gap-7"
          >
            <Link
              to={routePaths.caniuseCompare}
              aria-current={current === "compare" ? "page" : undefined}
              className="caniuse-nav-link"
            >
              Compare clients
            </Link>
            <Link
              to={CANIUSE_CAPABILITIES_HOME}
              aria-current={current === "capabilities" ? "page" : undefined}
              className="caniuse-nav-link"
            >
              Capabilities
            </Link>
          </nav>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
