import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { cn } from "@/lib/utils";

interface AzureOpenAITableRowProps {
  baseUrl: string;
  onEdit: () => void;
}

export function AzureOpenAITableRow({
  baseUrl,
  onEdit,
}: AzureOpenAITableRowProps) {
  const isConfigured = Boolean(baseUrl);

  return (
    <Card
      className={cn(
        "group h-full gap-4 border bg-card px-6 py-6 transition-all hover:border-primary/40 hover:shadow-md dark:hover:shadow-xl",
        isConfigured ? "border-success/30" : "border-border/60",
      )}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          <img
            src="/azure_logo.png"
            alt="Azure OpenAI"
            className="size-6 object-contain"
          />
          <div className="">
            <h3 className="text-md font-semibold text-foreground pb-1">
              Azure OpenAI {isConfigured && <span className="text-md">✔️</span>}
            </h3>
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {isConfigured
                ? "Azure OpenAI configured"
                : "Connect to your Azure OpenAI"}
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <Button
          size="sm"
          variant={isConfigured ? "outline" : "secondary"}
          className="w-full"
          onClick={onEdit}
        >
          {isConfigured ? "Manage" : "Configure"}
        </Button>
      </div>
    </Card>
  );
}
