import { JamIllustration } from "./JamIllustration";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";

export function FrontierSignInDialogView({
  onSignIn,
  onDismiss,
  modal = true,
}: {
  onSignIn: () => void;
  onDismiss: () => void;
  modal?: boolean;
}) {
  return (
    <Dialog
      open
      modal={modal}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <JamIllustration />
        <DialogHeader>
          <DialogTitle>Get access to frontier models</DialogTitle>
          <DialogDescription>
            Sign in to test your MCP server with frontier models from OpenAI and
            Anthropic. You can keep using standard models without signing in.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2 text-sm">
            <img
              src="/openai_logo.png"
              alt=""
              className="size-7 object-contain"
            />
            ChatGPT
          </span>
          <span className="flex items-center gap-2 text-sm">
            <img
              src="/claude_logo.png"
              alt=""
              className="size-7 object-contain"
            />
            Claude
          </span>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row-reverse">
          <Button onClick={onSignIn} className="flex-1">
            Sign in
          </Button>
          <Button variant="outline" onClick={onDismiss} className="flex-1">
            Not now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
