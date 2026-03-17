import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { Button } from "@/components/ui/button";
import { DiscordIcon } from "@/components/ui/discord-icon";
import { GitHubIcon } from "@/components/ui/github-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ActiveServerSelector,
  ActiveServerSelectorProps,
} from "@/components/ActiveServerSelector";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { Bug, CircleHelp, ExternalLink, BookOpenText } from "lucide-react";

interface AuthUpperAreaProps {
  activeServerSelectorProps?: ActiveServerSelectorProps;
}

export function AuthUpperArea({
  activeServerSelectorProps,
}: AuthUpperAreaProps) {
  const { user, signIn, signUp } = useAuth();
  const { isLoading } = useConvexAuth();
  const posthog = usePostHog();

  return (
    <div className="ml-auto flex h-full flex-1 items-center gap-2 no-drag min-w-0">
      {activeServerSelectorProps && (
        <div className="flex-1 min-w-0 h-full pr-2">
          <ActiveServerSelector
            {...activeServerSelectorProps}
            className="h-full"
          />
        </div>
      )}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label="Help & support">
                <CircleHelp className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              <DropdownMenuItem asChild>
                <a
                  href="https://docs.mcpjam.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  <BookOpenText className="size-4" />
                  Documentation
                  <ExternalLink className="ml-auto size-3 text-muted-foreground" />
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  href="https://discord.gg/JEnDtz8X6z"
                  target="_blank"
                  rel="noreferrer"
                >
                  <DiscordIcon className="size-4" />
                  Discord community
                  <ExternalLink className="ml-auto size-3 text-muted-foreground" />
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  href="https://github.com/MCPJam/inspector/issues/new"
                  target="_blank"
                  rel="noreferrer"
                >
                  <Bug className="size-4" />
                  Report a bug
                  <ExternalLink className="ml-auto size-3 text-muted-foreground" />
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  href="https://github.com/MCPJam/inspector"
                  target="_blank"
                  rel="noreferrer"
                >
                  <GitHubIcon className="size-4" />
                  GitHub repository
                  <ExternalLink className="ml-auto size-3 text-muted-foreground" />
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <NotificationBell />
        <div className="h-6 w-px bg-border/60" />
        {!user && !isLoading && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                posthog.capture("login_button_clicked", {
                  location: "header",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
                signIn();
              }}
            >
              Sign in
            </Button>
            <Button
              size="sm"
              onClick={() => {
                posthog.capture("sign_up_button_clicked", {
                  location: "header",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
                signUp();
              }}
            >
              Create account
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
