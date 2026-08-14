export function exportStyleVariablesCss(
  variables: Record<string, string>,
): string {
  const body = Object.entries(variables)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `:root {\n${body}\n}\n`;
}

export function exportStyleVariablesJson(
  variables: Record<string, string>,
): string {
  return `${JSON.stringify(variables, null, 2)}\n`;
}
