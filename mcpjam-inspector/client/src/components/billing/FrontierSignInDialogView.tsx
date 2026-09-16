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
            Sign in to test your MCP server with frontier models. You can keep using standard models without signing in.
          </DialogDescription>
        </DialogHeader>
        <div
          className="isolate flex items-center py-1"
          role="img"
          aria-label="ChatGPT, Claude, Gemini, and DeepSeek"
        >
          {[
            { name: "ChatGPT", src: "/openai_logo.png" },
            { name: "Claude", src: "/claude_logo.png" },
            { name: "Gemini", src: "/google_logo.png" },
            { name: "DeepSeek", src: "/deepseek_logo.svg" },
          ].map(({ name, src }, index) => (
            <span
              key={name}
              title={name}
              className="relative -ml-6 flex size-12 shrink-0 items-center justify-center rounded-full border border-border bg-background ring-2 ring-background first:ml-0 motion-safe:transition-transform motion-safe:duration-150 motion-safe:hover:-translate-y-1"
              style={{ zIndex: 4 - index }}
            >
              <img src={src} alt="" className="size-6 object-contain" />
            </span>
          ))}
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
