import { Plus, ShieldX, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
  isGeneratingNegativeTests: boolean;
  onGenerateTests: () => void;
  onGenerateNegativeTests: () => void;
  onAddTestTemplate: () => void;
  onAddNegativeTestTemplate: () => void;
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
  isGeneratingNegativeTests,
  onGenerateTests,
  onGenerateNegativeTests,
  onAddTestTemplate,
  onAddNegativeTestTemplate,
  onRemoveTestTemplate,
  onUpdateTestTemplate,
}: TestsStepProps) {
  const hasExistingContent =
    testTemplates.length > 0 &&
    testTemplates.some((template) => template.query.trim().length > 0);

  const renderPositiveTestCard = (template: TestTemplate, index: number) => (
    <div key={index} className="space-y-3 rounded-lg border bg-background p-4">
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
        <Label className="text-xs uppercase text-muted-foreground">Query</Label>
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
        <Label className="text-xs uppercase text-muted-foreground">Runs</Label>
        <Input
          type="number"
          min={1}
          value={template.runs}
          onChange={(event) =>
            onUpdateTestTemplate(
              index,
              "runs",
              Number(event.target.value) > 0 ? Number(event.target.value) : 1,
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
  );

  const renderNegativeTestCard = (template: TestTemplate, index: number) => (
    <div
      key={index}
      className="space-y-3 rounded-lg border border-orange-500/50 bg-orange-50/5 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="bg-orange-500/10 text-orange-600 border-orange-500/30"
          >
            <ShieldX className="h-3 w-3 mr-1" />
            Negative Test
          </Badge>
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

      <div className="flex flex-col flex-1 space-y-2">
        <Label className="text-xs uppercase text-muted-foreground">Title</Label>
        <Input
          className="w-full"
          value={template.title}
          onChange={(event) =>
            onUpdateTestTemplate(index, "title", event.target.value)
          }
          placeholder="Meta question about search"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs uppercase text-muted-foreground">
          Scenario
        </Label>
        <p className="text-xs text-muted-foreground mb-1">
          Describe why the AI should NOT trigger any tools for this prompt
        </p>
        <Textarea
          value={template.scenario || ""}
          onChange={(event) =>
            onUpdateTestTemplate(index, "scenario", event.target.value)
          }
          placeholder="User is asking about how the search feature works, not performing a search"
          rows={2}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs uppercase text-muted-foreground">
          User Prompt
        </Label>
        <p className="text-xs text-muted-foreground mb-1">
          The prompt that should NOT trigger any tools
        </p>
        <Textarea
          value={template.query}
          onChange={(event) =>
            onUpdateTestTemplate(index, "query", event.target.value)
          }
          placeholder="Can you explain what parameters the search tool accepts?"
          rows={3}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs uppercase text-muted-foreground">Runs</Label>
        <Input
          type="number"
          min={1}
          value={template.runs}
          onChange={(event) =>
            onUpdateTestTemplate(
              index,
              "runs",
              Number(event.target.value) > 0 ? Number(event.target.value) : 1,
            )
          }
        />
      </div>
    </div>
  );

  const renderTemplates = () => (
    <div className="space-y-12">
      {testTemplates.map((template, index) =>
        template.isNegativeTest
          ? renderNegativeTestCard(template, index)
          : renderPositiveTestCard(template, index),
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onAddTestTemplate}
          aria-label="Add test case"
          className="flex-1"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add test case
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onAddNegativeTestTemplate}
          aria-label="Add negative test case"
          className="flex-1 border-orange-500/30 text-orange-600 hover:bg-orange-50/10"
        >
          <ShieldX className="h-4 w-4 mr-2" />
          Add negative test
        </Button>
      </div>
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

  const isAnyGenerating = isGenerating || isGeneratingNegativeTests;

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
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onGenerateTests}
              disabled={isAnyGenerating}
            >
              {isGenerating ? "Generating..." : "Generate tests"}
              <Sparkles className="h-4 w-4 ml-2" />
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onGenerateNegativeTests}
              disabled={isAnyGenerating}
              className="border-orange-500/30 text-orange-600 hover:bg-orange-50/10"
            >
              {isGeneratingNegativeTests
                ? "Generating..."
                : "Generate negative tests"}
              <ShieldX className="h-4 w-4 ml-2" />
            </Button>
          </div>
        )}
      </div>

      {isAnyGenerating && hasServerAndModelSelection ? (
        <div className="flex items-center justify-center rounded-lg border p-6">
          <div className="text-center text-sm text-muted-foreground">
            {isGenerating
              ? "Generating test cases..."
              : "Generating negative test cases..."}
          </div>
        </div>
      ) : (
        renderTemplates()
      )}
    </div>
  );
}
