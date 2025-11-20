import { Plus, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ExpectedToolsEditor } from "../expected-tools-editor";
import type {
  AvailableTool,
  TestTemplate,
} from "@/components/evals/eval-runner/types";

interface TestsStepProps {
  testTemplates: TestTemplate[];
  availableTools: AvailableTool[];
  canGenerateTests: boolean;
  hasServerAndModelSelection: boolean;
  isGenerating: boolean;
  onGenerateTests: () => void;
  onAddTestTemplate: () => void;
  onRemoveTestTemplate: (index: number) => void;
  onUpdateTestTemplate: <K extends keyof TestTemplate>(
    index: number,
    field: K,
    value: TestTemplate[K],
  ) => void;
}

export function TestsStep({
  testTemplates,
  availableTools,
  canGenerateTests,
  hasServerAndModelSelection,
  isGenerating,
  onGenerateTests,
  onAddTestTemplate,
  onRemoveTestTemplate,
  onUpdateTestTemplate,
}: TestsStepProps) {
  const hasExistingContent =
    testTemplates.length > 0 &&
    testTemplates.some((template) => template.query.trim().length > 0);

  const renderTemplates = () => (
    <div className="space-y-12">
      {testTemplates.map((template, index) => (
        <div
          key={index}
          className="space-y-3 rounded-lg border bg-background p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col flex-1 space-y-2">
              <Label className="text-xs uppercase text-muted-foreground">
                Title
              </Label>
              <Input
                className="w-full"
                value={template.title}
                onChange={(event) =>
                  onUpdateTestTemplate(index, "title", event.target.value)
                }
                placeholder="(Paypal) List transactions"
              />
            </div>
            {testTemplates.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRemoveTestTemplate(index)}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase text-muted-foreground">
              Query
            </Label>
            <Textarea
              value={template.query}
              onChange={(event) =>
                onUpdateTestTemplate(index, "query", event.target.value)
              }
              placeholder="Can you find the most recent Paypal transactions, then create an invoice?"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase text-muted-foreground">
              Runs
            </Label>
            <Input
              type="number"
              min={1}
              value={template.runs}
              onChange={(event) =>
                onUpdateTestTemplate(
                  index,
                  "runs",
                  Number(event.target.value) > 0
                    ? Number(event.target.value)
                    : 1,
                )
              }
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase text-muted-foreground">
              Expected tools
            </Label>
            <ExpectedToolsEditor
              toolCalls={template.expectedToolCalls}
              onChange={(toolCalls) =>
                onUpdateTestTemplate(index, "expectedToolCalls", toolCalls)
              }
              availableTools={availableTools}
            />
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        onClick={onAddTestTemplate}
        aria-label="Add test case"
        className="w-full"
      >
        <Plus className="h-4 w-4 mr-2" />
        Add test case
      </Button>
    </div>
  );

  const shouldShowLockedState =
    !hasServerAndModelSelection && !hasExistingContent;

  if (shouldShowLockedState) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg pb-2">Define your test cases</h3>
            <p className="text-sm text-muted-foreground">
              Specify tool names and their expected arguments. Leave arguments
              empty to skip argument checking.
            </p>
          </div>
        </div>
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            Finish previous steps first
          </p>
          <p className="mt-2">
            Select at least one server and choose a model to unlock test
            authoring. That ensures generated tests know which stack to target.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg">Define your test cases</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Specify tool names and their expected arguments. Leave arguments
            empty to skip argument checking.
          </p>
        </div>
        {canGenerateTests && (
          <Button
            type="button"
            variant="outline"
            onClick={onGenerateTests}
            disabled={isGenerating}
          >
            {isGenerating ? "Generating..." : "Generate tests"}
            <Sparkles className="h-4 w-4 ml-2" />
          </Button>
        )}
      </div>

      {isGenerating && hasServerAndModelSelection ? (
        <div className="flex items-center justify-center rounded-lg border p-6">
          <div className="text-center text-sm text-muted-foreground">
            Generating test cases...
          </div>
        </div>
      ) : (
        renderTemplates()
      )}
    </div>
  );
}
