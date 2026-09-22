import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import { Label } from "@mcpjam/design-system/label";
import {
  generationPreset,
  loadGenerateConfig,
  saveGenerateConfig,
  type GenerateCasesConfig,
} from "@/lib/evals/eval-generation-config";

export function GenerateCasesDialog({
  suiteId,
  onClose,
  onGenerate,
}: {
  suiteId: string;
  onClose: () => void;
  onGenerate: (config: GenerateCasesConfig) => void;
}) {
  const [initial] = useState(() => loadGenerateConfig(suiteId));
  const [testSet, setTestSet] = useState<"quick" | "comprehensive">(
    initial.testSet ?? "quick",
  );
  const [coverage, setCoverage] = useState<"read-only" | "read-write">(
    initial.toolCoverage ?? "read-only",
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const config = generationPreset(testSet, coverage);
            saveGenerateConfig(suiteId, config);
            onGenerate(config);
          }}
          className="space-y-6"
        >
          <DialogHeader>
            <DialogTitle>Generate test cases</DialogTitle>
            <DialogDescription>
              Choose the size and scope of this batch.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Test set</legend>
            <RadioGroup
              aria-label="Test set"
              value={testSet}
              onValueChange={(value) => setTestSet(value as typeof testSet)}
              className="grid grid-cols-2 gap-3"
            >
              {(
                [
                  ["quick", "Quick set", "5–10 cases"],
                  ["comprehensive", "Comprehensive", "20 cases"],
                ] as const
              ).map(([value, title, description]) => (
                <Label
                  key={value}
                  htmlFor={`generate-${value}`}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
                >
                  <RadioGroupItem id={`generate-${value}`} value={value} />
                  <span className="space-y-1">
                    <span className="block text-sm">{title}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {description}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Tool coverage</legend>
            <RadioGroup
              aria-label="Tool coverage"
              value={coverage}
              onValueChange={(value) => setCoverage(value as typeof coverage)}
              className="grid grid-cols-2 gap-3"
            >
              {(
                [
                  ["read-only", "Read-only", "Retrieval and discovery"],
                  [
                    "read-write",
                    "Read and write",
                    "Include workflows that change data",
                  ],
                ] as const
              ).map(([value, title, description]) => (
                <Label
                  key={value}
                  htmlFor={`generate-${value}`}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
                >
                  <RadioGroupItem id={`generate-${value}`} value={value} />
                  <span className="space-y-1">
                    <span className="block text-sm">{title}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {description}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Generate cases</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
