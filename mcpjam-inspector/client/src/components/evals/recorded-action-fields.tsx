import type { InteractAction } from "@/shared/steps";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { LocatorFields } from "./scripted-steps-editor";

type RecordedAction = Extract<InteractAction, { kind: "select" | "scrollTo" }>;
type RecordedActionFieldsProps = {
  value: RecordedAction;
  onChange: (value: RecordedAction) => void;
  readOnly?: boolean;
};

export function RecordedActionFields({
  value,
  onChange,
  readOnly = false,
}: RecordedActionFieldsProps) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Target</div>
      <LocatorFields
        value={value.target}
        onChange={(target) => onChange({ ...value, target })}
        readOnly={readOnly}
      />
      {value.kind === "select" ? (
        <div className="space-y-2">
          <div className="text-sm font-medium">Selected options</div>
          {value.values.map((option, index) => (
            <div className="flex gap-2" key={index}>
              <Input
                aria-label={`Option value ${index + 1}`}
                value={option}
                readOnly={readOnly}
                onChange={(event) =>
                  onChange({
                    ...value,
                    values: value.values.map((saved, i) =>
                      i === index ? event.target.value : saved,
                    ),
                  })
                }
              />
              {!readOnly ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    onChange({
                      ...value,
                      values: value.values.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
          {!readOnly ? (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                onChange({ ...value, values: [...value.values, ""] })
              }
            >
              Add option
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex gap-2">
          {(["x", "y"] as const).map((axis) => (
            <Input
              key={axis}
              type="number"
              aria-label={`Scroll position ${axis}`}
              value={value[axis]}
              readOnly={readOnly}
              onChange={(event) =>
                onChange({ ...value, [axis]: Number(event.target.value) })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
