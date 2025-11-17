import type { KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PassCriteriaSelector } from "../pass-criteria-selector";
import type { ModelDefinition } from "@/shared/types";
import type { TestTemplate } from "@/components/evals/eval-runner/types";

interface ReviewStepProps {
  suiteName: string;
  suiteDescription: string;
  isEditingSuiteName: boolean;
  editedSuiteName: string;
  minimumPassRate: number;
  selectedServers: string[];
  selectedModels: ModelDefinition[];
  validTestTemplates: TestTemplate[];
  onSuiteNameClick: () => void;
  onSuiteNameBlur: () => void;
  onSuiteNameKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onEditedSuiteNameChange: (value: string) => void;
  onSuiteDescriptionChange: (value: string) => void;
  onMinimumPassRateChange: (value: number) => void;
  onEditStep: (stepIndex: number) => void;
}

export function ReviewStep({
  suiteName,
  suiteDescription,
  isEditingSuiteName,
  editedSuiteName,
  minimumPassRate,
  selectedServers,
  selectedModels,
  validTestTemplates,
  onSuiteNameClick,
  onSuiteNameBlur,
  onSuiteNameKeyDown,
  onEditedSuiteNameChange,
  onSuiteDescriptionChange,
  onMinimumPassRateChange,
  onEditStep,
}: ReviewStepProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {isEditingSuiteName ? (
          <input
            type="text"
            value={editedSuiteName}
            onChange={(event) => onEditedSuiteNameChange(event.target.value)}
            onBlur={onSuiteNameBlur}
            onKeyDown={onSuiteNameKeyDown}
            autoFocus
            className="w-full px-3 py-2 text-lg font-semibold border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring bg-background"
            placeholder="New Test Suite"
          />
        ) : (
          <Button
            variant="ghost"
            onClick={onSuiteNameClick}
            className="w-full justify-start px-3 py-2 h-auto text-lg font-semibold hover:bg-accent border border-transparent hover:border-input rounded-md"
          >
            {suiteName || (
              <span className="text-muted-foreground">New Test Suite</span>
            )}
          </Button>
        )}
        <Textarea
          value={suiteDescription}
          onChange={(event) => onSuiteDescriptionChange(event.target.value)}
          rows={3}
          placeholder="What does this suite cover?"
          className="resize-none"
        />
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
