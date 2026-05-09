import { useEffect, useState } from "react";
import { Loader2, Settings2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Slider } from "@mcpjam/design-system/slider";
import { Textarea } from "@mcpjam/design-system/textarea";
import type { EvalSuite } from "./types";
import type { ModelDefinition } from "@/shared/types";

type SuiteExecutionConfigEditorProps = {
  suite: Pick<EvalSuite, "_id" | "defaultConfig">;
  availableModels: ModelDefinition[];
  onSave: (
    defaultConfig: NonNullable<EvalSuite["defaultConfig"]>
  ) => Promise<void>;
};

const DEFAULT_TEMPERATURE = 0.7;

export function SuiteExecutionConfigEditor({
  suite,
  availableModels,
  onSave,
}: SuiteExecutionConfigEditorProps) {
  const [modelId, setModelId] = useState(suite.defaultConfig?.modelId ?? "");
  const [systemPrompt, setSystemPrompt] = useState(
    suite.defaultConfig?.systemPrompt ?? ""
  );
  const [temperature, setTemperature] = useState(
    suite.defaultConfig?.temperature ?? DEFAULT_TEMPERATURE
  );
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setModelId(suite.defaultConfig?.modelId ?? "");
    setSystemPrompt(suite.defaultConfig?.systemPrompt ?? "");
    setTemperature(suite.defaultConfig?.temperature ?? DEFAULT_TEMPERATURE);
  }, [suite.defaultConfig]);

  const savedModelId = suite.defaultConfig?.modelId ?? "";
  const savedSystemPrompt = suite.defaultConfig?.systemPrompt ?? "";
  const savedTemperature =
    suite.defaultConfig?.temperature ?? DEFAULT_TEMPERATURE;

  const isDirty =
    modelId !== savedModelId ||
    systemPrompt !== savedSystemPrompt ||
    temperature !== savedTemperature;

  const handleReset = () => {
    setModelId(savedModelId);
    setSystemPrompt(savedSystemPrompt);
    setTemperature(savedTemperature);
  };

  const handleSave = async () => {
    if (!modelId) return;
    setIsSaving(true);
    try {
      await onSave({ modelId, systemPrompt, temperature });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Default Execution Config
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          The model and parameters all iterations in this suite inherit. Per-case{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
            advancedConfig
          </code>{" "}
          overrides take precedence.
        </p>
      </div>

      <div className="space-y-4 rounded-xl border bg-card/60 p-4">
        {/* Model */}
        <div>
          <Label className="text-xs font-medium text-muted-foreground">
            Model
          </Label>
          <Select value={modelId} onValueChange={setModelId}>
            <SelectTrigger className="mt-1.5 border-0 bg-muted/50 transition-colors hover:bg-muted">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map((model) => (
                <SelectItem key={String(model.id)} value={String(model.id)}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* System prompt */}
        <div>
          <Label className="text-xs font-medium text-muted-foreground">
            System prompt
          </Label>
          <p className="mb-1.5 mt-0.5 text-[10px] text-muted-foreground">
            Instructions given to the model at the start of each run.
          </p>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are a helpful assistant…"
            className="min-h-[80px] resize-y border-0 bg-muted/50 text-sm"
          />
        </div>

        {/* Temperature */}
        <div>
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium text-muted-foreground">
              Temperature
            </Label>
            <span className="text-xs text-muted-foreground">
              {temperature.toFixed(2)}
            </span>
          </div>
          <Slider
            min={0}
            max={2}
            step={0.05}
            value={[temperature]}
            onValueChange={(values) =>
              setTemperature(values[0] ?? DEFAULT_TEMPERATURE)
            }
            className="mt-3"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Settings2 className="h-3.5 w-3.5" />
          <span>
            {modelId
              ? `Default: ${modelId}`
              : "No default model configured"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={!isDirty || isSaving}
          >
            Reset
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!isDirty || isSaving || !modelId}
          >
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Save config
          </Button>
        </div>
      </div>
    </section>
  );
}
