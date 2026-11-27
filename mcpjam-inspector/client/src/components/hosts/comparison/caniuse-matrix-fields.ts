import { NOT_SUPPORTED, type HostConfigFieldDef } from "@/lib/host-config-field-schema";
import { caniuseTitle } from "./caniuse-coverage";
import { matchesCaniuseQuery } from "./CaniuseCapabilitySearch";

export function buildCaniuseMatrixFields(
  fields: readonly HostConfigFieldDef[],
  protocol: HostConfigFieldDef | undefined,
  versions: readonly { slice: string }[],
  query: string,
): HostConfigFieldDef[] {
  const term = query.trim();
  return fields.flatMap((field) => {
    const matches = matchesCaniuseQuery(field, query);
    if (field !== protocol || versions.length === 0) {
      return matches ? [{ ...field, label: caniuseTitle(field) }] : [];
    }
    const dates = versions.map(({ slice }) => slice).filter((slice) => matches || slice.includes(term));
    const slices = matches ? [undefined, ...dates] : dates;
    return slices.map((slice): HostConfigFieldDef => ({
      ...field,
      id: slice ? `${field.id}:${slice}` : field.id,
      label: slice ?? caniuseTitle(field),
      description: slice ? undefined : field.description,
      kind: { kind: "boolean" },
      read: (config) => {
        const value = field.read(config);
        if (Array.isArray(value)) return slice ? value.includes(slice) : value.length > 0;
        return value === NOT_SUPPORTED ? false : undefined;
      },
    }));
  });
}
