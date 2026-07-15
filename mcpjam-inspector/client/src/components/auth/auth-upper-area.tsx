import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { GitHubStarButton } from "@/components/ui/github-star-button";
import {
  ActiveServerSelector,
  ActiveServerSelectorProps,
} from "@/components/ActiveServerSelector";
import { AgentSidePanelTrigger } from "@/components/mcpjam-agent/AgentSidePanelTrigger";
import { GlobalHostBar } from "@/components/hosts/GlobalHostBar";
import { track } from "@/lib/analytics";
import type { GlobalHostBarProps } from "@/components/Header";

interface AuthUpperAreaProps {
  activeServerSelectorProps?: ActiveServerSelectorProps;
  globalHostBarProps?: GlobalHostBarProps;
}

export function AuthUpperArea({
  activeServerSelectorProps,
  globalHostBarProps,
}: AuthUpperAreaProps) {
  const { user, signIn, signUp } = useAuth();
  const { isLoading } = useConvexAuth();

  return (
    <div className="ml-auto flex h-full flex-1 items-center gap-2 no-drag min-w-0">
      {globalHostBarProps ? (
        <div className="flex shrink-0 items-center pr-1">
          <GlobalHostBar {...globalHostBarProps} />
        </div>
      ) : null}
      {activeServerSelectorProps ? (
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
        <AgentSidePanelTrigger />
        {!user && !isLoading && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                track("login_button_clicked", { location: "header" });
                signIn();
              }}
            >
              Sign in
            </Button>
            <Button
              size="sm"
              onClick={() => {
                track("sign_up_button_clicked", { location: "header" });
                signUp();
              }}
            >
              Create account
            </Button>
          </>
        )}
        <GitHubStarButton />
      </div>
    </div>
  );
}
