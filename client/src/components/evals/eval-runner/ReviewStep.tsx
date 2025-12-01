import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PassCriteriaSelector } from "../pass-criteria-selector";
import { cn } from "@/lib/utils";
import type { ModelDefinition } from "@/shared/types";
import type { TestTemplate } from "@/components/evals/eval-runner/types";

interface ReviewStepProps {
  suiteName: string;
  suiteDescription: string;
  minimumPassRate: number;
  selectedServers: string[];
  selectedModels: ModelDefinition[];
  validTestTemplates: TestTemplate[];
  onSuiteNameChange: (value: string) => void;
  onSuiteDescriptionChange: (value: string) => void;
  onMinimumPassRateChange: (value: number) => void;
  onEditStep: (stepIndex: number) => void;
  showNameError?: boolean;
}

export function ReviewStep({
  suiteName,
  suiteDescription,
  minimumPassRate,
  selectedServers,
  selectedModels,
  validTestTemplates,
  onSuiteNameChange,
  onSuiteDescriptionChange,
  onMinimumPassRateChange,
  onEditStep,
  showNameError = false,
}: ReviewStepProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="suite-name" className="text-sm font-medium">
            Test Suite Name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="suite-name"
            type="text"
            value={suiteName}
            onChange={(event) => onSuiteNameChange(event.target.value)}
            placeholder="e.g., Weather API Integration Tests"
            className={cn(
              "text-lg font-semibold",
              showNameError &&
                !suiteName.trim() &&
                "border-destructive focus-visible:ring-destructive",
            )}
            autoFocus
          />
          {showNameError && !suiteName.trim() && (
            <p className="text-sm text-destructive font-medium">
              Please provide a name for this test suite
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="suite-description" className="text-sm font-medium">
            Description (optional)
          </Label>
          <Textarea
            id="suite-description"
            value={suiteDescription}
            onChange={(event) => onSuiteDescriptionChange(event.target.value)}
            rows={3}
            placeholder="What does this suite cover?"
            className="resize-none"
          />
        </div>
      </div>

      <PassCriteriaSelector
        minimumPassRate={minimumPassRate}
        onMinimumPassRateChange={onMinimumPassRateChange}
      />

      <div className="space-y-2">
        <h3 className="text-lg">Review your configuration</h3>
        <p className="text-sm text-muted-foreground">
          After confirming the run, you will see your run begin in the eval
          results tab.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border bg-background p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Servers</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {selectedServers.map((server) => (
                <Badge key={server} variant="outline">
                  {server}
                </Badge>
              ))}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onEditStep(0)}
          >
            Edit
          </Button>
        </div>
        <Separator />
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Models</p>
            {selectedModels.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {selectedModels.map((model) => (
                  <Badge key={model.id} variant="outline">
                    {model.name}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                No models selected
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onEditStep(1)}
          >
            Edit
          </Button>
        </div>
        <Separator />
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1">
            <p className="text-sm font-medium text-muted-foreground">
              Test Templates
            </p>
            <div className="mt-3 space-y-3">
              {validTestTemplates.map((template, index) => (
                <div key={index} className="rounded-md border bg-muted/30 p-3">
                  <p className="text-sm font-semibold text-foreground">
                    {template.title}
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {template.query}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      {template.runs} run{template.runs === 1 ? "" : "s"}
                    </span>
                    {template.expectedToolCalls.length > 0 && (
                      <span>
                        Tools:{" "}
                        {template.expectedToolCalls
                          .map((tc) => tc.toolName)
                          .join(", ")}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onEditStep(2)}
          >
            Edit
          </Button>
        </div>
      </div>
    </div>
  );
}
