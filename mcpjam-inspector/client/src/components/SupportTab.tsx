import { BookOpen, ExternalLink } from "lucide-react";
import { DiscordIcon } from "@/components/ui/discord-icon";
import { GitHubIcon } from "@/components/ui/github-icon";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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
    <div className="h-full w-full overflow-auto">
      <div className="mx-auto flex min-h-full w-full max-w-6xl items-center justify-center p-6 md:p-10">
        <div className="w-full max-w-5xl space-y-5">
          <div className="grid w-full gap-6 md:grid-cols-3">
            {supportLinks.map((item) => {
              const Icon = item.icon;
              return (
                <Card
                  key={item.title}
                  className="flex h-full flex-col justify-between border-border/60"
                >
                  <CardHeader>
                    <Icon className="mb-2 size-6 text-muted-foreground" />
                    <CardTitle>{item.title}</CardTitle>
                    <CardDescription>{item.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button asChild className="w-full">
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.cta}
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <p className="text-center text-sm text-muted-foreground">
            or email us at{" "}
            <a className="underline" href="mailto:matthew@mcpjam.com">
              matthew@mcpjam.com
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
