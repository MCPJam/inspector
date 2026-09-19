import { BookOpen, ExternalLink } from "lucide-react";
import { DiscordIcon } from "@/components/ui/discord-icon";
import { GitHubIcon } from "@/components/ui/github-icon";
import { Button } from "@mcpjam/design-system/button";
import { SettingsPageShell } from "./settings/SettingsPageShell";
import { SettingsPageDescription } from "./settings/SettingsPageDescription";

const supportLinks = [
  {
    title: "Discord Community",
    description:
      "Project maintainers are active on our Discord server. Get quick help here.",
    href: "https://discord.gg/JEnDtz8X6z",
    cta: "Join Discord",
    icon: DiscordIcon,
  },
  {
    title: "Documentation",
    description: "Browse setup guides and reference docs.",
    href: "https://docs.mcpjam.com/",
    cta: "Open Docs",
    icon: BookOpen,
  },
  {
    title: "Report an Issue",
    description: "File a bug or request an improvement on GitHub.",
    href: "https://github.com/MCPJam/inspector/issues/new",
    cta: "Open Issue",
    icon: GitHubIcon,
  },
];

export function SupportTab() {
  return (
    <SettingsPageShell>
      <div className="max-w-2xl space-y-7 text-accent-foreground">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Support</h1>
          <SettingsPageDescription>
            Get help, find answers, and share feedback with the MCPJam team.
          </SettingsPageDescription>
        </header>
        <div className="divide-y divide-border">
          {supportLinks.map((item) => {
            const Icon = item.icon;
            return (
              <section
                key={item.title}
                className="flex flex-wrap items-center justify-between gap-4 py-5 first:pt-0"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">{item.title}</h2>
                    <p className="text-sm text-foreground/80">
                      {item.description}
                    </p>
                  </div>
                </div>
                <Button asChild variant="outline" size="sm">
                  <a href={item.href} target="_blank" rel="noopener noreferrer">
                    {item.cta}
                    <ExternalLink aria-hidden="true" className="size-3.5" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </Button>
              </section>
            );
          })}
        </div>
        <section className="space-y-2 border-t border-border pt-6">
          <h2 className="text-sm font-semibold">Contact us</h2>
          <p className="text-sm text-foreground/80">
            Prefer email? Reach our team at{" "}
            <a
              className="text-foreground underline underline-offset-4"
              href="mailto:founders@mcpjam.com"
            >
              founders@mcpjam.com
            </a>
            .
          </p>
        </section>
      </div>
    </SettingsPageShell>
  );
}
