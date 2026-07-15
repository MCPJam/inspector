type ToolWithMetadata = {
  name: string;
  _meta?: Record<string, unknown>;
};

type ToolListWithMetadata<TTool extends ToolWithMetadata = ToolWithMetadata> = {
  tools?: TTool[];
  toolsMetadata?: Record<string, Record<string, any>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function attachToolMetadata<T extends ToolListWithMetadata>(
  result: T,
): T {
  const toolsMetadata = result.toolsMetadata;
  if (!toolsMetadata || !Array.isArray(result.tools)) return result;

  return {
    ...result,
    tools: result.tools.map((tool) => {
      const metadata = toolsMetadata[tool.name];
      if (!metadata) return tool;
      const toolMeta = tool._meta as Record<string, unknown> | undefined;
      const toolUi = toolMeta?.ui;
      const metadataUi = metadata.ui;
      return {
        ...tool,
        _meta: {
          ...toolMeta,
          ...metadata,
          ...(isRecord(toolUi) || isRecord(metadataUi)
            ? {
                ui: {
                  ...(isRecord(toolUi) ? toolUi : {}),
                  ...(isRecord(metadataUi) ? metadataUi : {}),
                },
              }
            : {}),
        },
      };
    }),
  } as T;
}
