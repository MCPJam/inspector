import { useState } from "react";
import { BookOpen, ExternalLink, LogIn, MessageSquare } from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import { DiscordIcon } from "@/components/ui/discord-icon";
import { GitHubIcon } from "@/components/ui/github-icon";
import { Button } from "@mcpjam/design-system/button";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { SettingsPageShell } from "./settings/SettingsPageShell";
import { SettingsPageDescription } from "./settings/SettingsPageDescription";
import { SendFeedbackDialog } from "./support/SendFeedbackDialog";

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

/**
 * The in-app way to send the MCPJam team a report — the same write the
 * `send_feedback` MCP tool makes. Reports need an account, so a guest gets the
 * sign-in prompt instead, and an identity still settling gets a disabled
 * button rather than a guess either way (see `useIsMemberActor`).
 */
function SendFeedbackRow() {
  const isMember = useIsMemberActor();
  const { signIn } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <section
      className="flex flex-wrap items-center justify-between gap-4 py-5 first:pt-0"
      data-testid="support-send-feedback"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <MessageSquare aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Send feedback</h2>
          <p className="text-sm text-foreground/80">
            {isMember === false
              ? "Sign in to tell the MCPJam team about a bug, a missing capability, or something confusing."
              : "Tell the MCPJam team about a bug, a missing capability, or something confusing."}
          </p>
        </div>
      </div>
      {isMember === false ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // Back here after sign-in, not to the app's front door.
            captureAppSignInReturnPath();
            signIn(permalinkSignInOptions());
          }}
        >
          <LogIn aria-hidden="true" className="size-3.5" />
          Sign in
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={isMember !== true}
          onClick={() => setOpen(true)}
        >
          Send feedback
        </Button>
      )}
      {isMember === true ? (
        <SendFeedbackDialog open={open} onOpenChange={setOpen} />
      ) : null}
    </section>
  );
}

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
          <SendFeedbackRow />
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
