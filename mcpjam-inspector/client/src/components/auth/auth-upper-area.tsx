import type { ReactNode } from "react";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { GitHubStarButton } from "@/components/ui/github-star-button";
import {
  ActiveServerSelector,
  ActiveServerSelectorProps,
} from "@/components/ActiveServerSelector";
import { AgentSidePanelTrigger } from "@/components/mcpjam-agent/AgentSidePanelTrigger";
import { OnboardAgentButton } from "@/components/onboard-agent/OnboardAgentButton";
import { ProjectClientBootstrap } from "@/components/hosts/ProjectClientBootstrap";
import { track } from "@/lib/analytics";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import type { ClientBootstrapProps } from "@/components/Header";
import { cn } from "@/lib/utils";

interface AuthUpperAreaProps {
  activeServerSelectorProps?: ActiveServerSelectorProps;
  clientBootstrapProps?: ClientBootstrapProps;
  breadcrumb?: ReactNode;
}

export function AuthUpperArea({
  activeServerSelectorProps,
  clientBootstrapProps,
  breadcrumb,
}: AuthUpperAreaProps) {
  const { user, signIn, signUp } = useInspectorAuth();
  const { isLoading } = useConvexAuth();

  return (
    <div className={cn(
      "ml-auto flex h-full flex-1 items-center gap-2 no-drag min-w-0",
      breadcrumb && "max-md:flex-wrap",
    )}>
      {clientBootstrapProps ? (
        <ProjectClientBootstrap {...clientBootstrapProps} />
      ) : null}
      {breadcrumb ? (
        <div className="min-w-0 flex-1 max-md:order-last max-md:basis-full">
          {breadcrumb}
        </div>
      ) : activeServerSelectorProps ? (
        <div className="flex-1 min-w-0 h-full pr-2">
          <ActiveServerSelector
            {...activeServerSelectorProps}
            className="h-full"
          />
        </div>
      ) : (
        <div className="flex-1 min-w-0 h-full pr-2" />
      )}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {user && <OnboardAgentButton />}
        <AgentSidePanelTrigger />
        <GitHubStarButton location="header" prompt />
        {!user && !isLoading && (
          <>
            <Button
              variant="chrome"
              size="sm"
              onClick={() => {
                track("login_button_clicked", { location: "header" });
                // Remember where they were, so WorkOS returns them to this
                // exact URL — project segment included — rather than the
                // app's front door.
                captureAppSignInReturnPath();
                signIn(permalinkSignInOptions());
              }}
            >
              Sign in
            </Button>
            <Button
              size="sm"
              onClick={() => {
                track("sign_up_button_clicked", { location: "header" });
                // Same return as sign-in: a first-time visitor arriving on a
                // permalink creates an account rather than signing in, and
                // losing the resource on that path loses it for exactly the
                // people who have never seen the product.
                signUp(permalinkSignInOptions());
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
