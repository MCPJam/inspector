import { isNumericMultipleOf } from "./json-number";
export { isNumericMultipleOf } from "./json-number";

export function validateNumericConstraints(
  value: number,
  field: {
    kind: string;
    minimum?: number;
    maximum?: number;
    multipleOf?: number;
  },
  label: string,
): string | null {
  if (!Number.isFinite(value)) return `${label} must be a number`;
  if (field.kind === "integer" && !Number.isInteger(value))
    return `${label} must be an integer`;
  if (
    [field.minimum, field.maximum].some(
      (bound) => bound !== undefined && !Number.isFinite(bound),
    ) ||
    (field.multipleOf !== undefined &&
      (!Number.isFinite(field.multipleOf) || field.multipleOf <= 0)) ||
    (field.minimum !== undefined &&
      field.maximum !== undefined &&
      field.minimum > field.maximum)
  )
    return `${label} has invalid numeric constraints`;
  if (field.minimum !== undefined && value < field.minimum)
    return `${label} must be at least ${field.minimum}`;
  if (field.maximum !== undefined && value > field.maximum)
    return `${label} must be at most ${field.maximum}`;
  if (
    field.multipleOf !== undefined &&
    !isNumericMultipleOf(value, field.multipleOf)
  )
    return `${label} must be a multiple of ${field.multipleOf}`;
  return null;
}
