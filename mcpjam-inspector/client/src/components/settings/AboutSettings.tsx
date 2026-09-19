import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { ArrowUpRight, Globe, ShieldCheck } from "lucide-react";
import { GitHubStarButton } from "../ui/github-star-button";

const links = [
  {
    label: "Website",
    description: "Explore MCPJam and what’s new.",
    href: "https://www.mcpjam.com",
    icon: Globe,
  },
  {
    label: "Trust center",
    description: "Security, compliance, and supporting documents.",
    href: "https://trust.mcpjam.com",
    icon: ShieldCheck,
  },
];

export function AboutSettings() {
  return (
    <section className="max-w-2xl space-y-8">
      <header className="space-y-5">
        <div>
          <img
            src="/mcp_jam_light.png"
            alt="MCPJam"
            className="h-8 w-auto dark:hidden"
          />
          <img
            src="/mcp_jam_dark.png"
            alt="MCPJam"
            className="hidden h-8 w-auto dark:block"
          />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-accent-foreground">
            About MCPJam
          </h1>
          <SettingsPageDescription>
            Test, debug, and evaluate your MCP servers and apps.
          </SettingsPageDescription>
        </div>
        <GitHubStarButton />
      </header>

      <dl className="flex items-center justify-between gap-4 border-y border-border py-4 text-sm">
        <dt className="font-medium text-accent-foreground">Version</dt>
        <dd className="text-foreground">v{__APP_VERSION__}</dd>
      </dl>

      <nav
        aria-label="MCPJam resources"
        className="divide-y divide-border rounded-lg border border-border"
      >
        {links.map(({ label, description, href, icon: Icon }) => (
          <a
            key={href}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 p-4 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon
              aria-hidden="true"
              className="size-5 shrink-0 text-foreground"
            />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block text-sm font-medium text-accent-foreground">
                {label}
              </span>
              <span className="block text-sm text-foreground">
                {description}
              </span>
            </span>
            <ArrowUpRight
              aria-hidden="true"
              className="size-4 shrink-0 text-foreground"
            />
            <span className="sr-only">Opens in a new tab</span>
          </a>
        ))}
      </nav>
    </section>
  );
}
