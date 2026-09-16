import { createContext } from "react";
import { SUPPORTED_MODELS, type ModelDefinition } from "@/shared/types";

export const ModelDisplayNamesContext = createContext<
  readonly Pick<ModelDefinition, "id" | "name">[]
>([]);

/** Match known aliases without inventing a label for an unknown model. */
export function modelDisplayName(
  id: string,
  models: readonly (Pick<ModelDefinition, "id" | "name"> &
    Partial<Pick<ModelDefinition, "provider">>)[] = [],
): string {
  const value = id
    .trim()
    .replace(/^external\//, "")
    .replace(/^mcpjam\//, "");
  const candidates = [...models, ...SUPPORTED_MODELS];
  const exact = candidates.find((model) => String(model.id) === value);
  if (exact) return exact.name;
  const key = (input: string) =>
    input
      .replace(/^mcpjam\//, "")
      .split("/")
      .at(-1)!
      .replace(/-\d{8}$/, "")
      .replace(/[._]/g, "-");
  const provider = value.includes("/") ? value.split("/")[0] : undefined;
  const known = candidates.find(
    (model) =>
      (!provider ||
        model.provider === provider ||
        String(model.id).startsWith(`${provider}/`)) &&
      key(String(model.id)) === key(value),
  );
  return known?.name ?? (id.startsWith("external/") ? id.slice(9) : id);
}
