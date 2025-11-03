import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MCPJamFreeModelsPromptProps {
  onSignUp: () => void;
  className?: string;
}

export function MCPJamFreeModelsPrompt({
  onSignUp,
  className,
}: MCPJamFreeModelsPromptProps) {
  return (
    <div
      className={cn(
        "max-w-2xl mx-auto space-y-4 text-center flex flex-col items-center justify-center",
        className,
      )}
    >
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">
          Test your MCP server with frontier models for free
        </h2>
      </div>

      <div className="flex justify-center items-center gap-4 py-3">
        <div className="flex items-center justify-center">
          <img
            src="/claude_logo.png"
            alt="Claude"
            className="w-8 h-8 object-contain opacity-70 hover:opacity-100 transition-opacity"
          />
        </div>
        <div className="flex items-center justify-center">
          <img
            src="/openai_logo.png"
            alt="OpenAI"
            className="w-8 h-8 object-contain opacity-70 hover:opacity-100 transition-opacity"
          />
        </div>
        <div className="flex items-center justify-center">
          <img
            src="/google_logo.png"
            alt="Google"
            className="w-8 h-8 object-contain opacity-70 hover:opacity-100 transition-opacity"
          />
        </div>
        <div className="flex items-center justify-center">
          <img
            src="/meta_logo.svg"
            alt="Meta"
            className="w-8 h-8 object-contain opacity-70 hover:opacity-100 transition-opacity"
          />
        </div>
        <div className="flex items-center justify-center">
          <img
            src="/grok_light.svg"
            alt="Grok"
            className="w-8 h-8 object-contain opacity-70 hover:opacity-100 transition-opacity"
          />
        </div>
      </div>

      <div className="space-y-2 text-center">
        <Button
          onClick={onSignUp}
          size="lg"
          className="hover:opacity-90 cursor-pointer font-semibold px-8 py-6 text-base"
        >
          Get started
        </Button>
        <p className="text-xs text-muted-foreground">
          or bring your own API key in{" "}
          <a
            href="#settings"
            className="underline hover:text-foreground transition-colors"
          >
            settings
          </a>
        </p>
      </div>
    </div>
  );
}
