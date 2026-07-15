import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "../host-config/types.js";
import type { HostImageSupport } from "./types.js";

export function imageSupportToHostConfigFields(
  imageSupport: HostImageSupport
): {
  modelVisibleMcpToolResults: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering: McpToolResultImageRenderingPolicy;
} {
  return {
    modelVisibleMcpToolResults: {
      directContent: { image: imageSupport.toolImageContent.model },
      embeddedResources: {
        blob: { image: imageSupport.embeddedResourceImages.model },
      },
      linkedResources: {
        blob: { image: imageSupport.resourceLinkImages.model },
      },
    },
    mcpToolResultImageRendering: {
      placement: imageSupport.placement,
      directContent: { image: imageSupport.toolImageContent.ui },
      embeddedResources: {
        blob: { image: imageSupport.embeddedResourceImages.ui },
      },
      linkedResources: {
        blob: { image: imageSupport.resourceLinkImages.ui },
      },
    },
  };
}

export function hostConfigFieldsToImageSupport(hostConfig: {
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
}): HostImageSupport | undefined {
  const model = hostConfig.modelVisibleMcpToolResults;
  const ui = hostConfig.mcpToolResultImageRendering;
  if (!model && !ui) return undefined;

  return {
    toolImageContent: {
      model: model?.directContent?.image === true,
      ui: ui?.directContent?.image === true,
    },
    embeddedResourceImages: {
      model: model?.embeddedResources?.blob?.image === true,
      ui: ui?.embeddedResources?.blob?.image === true,
    },
    resourceLinkImages: {
      model: model?.linkedResources?.blob?.image === true,
      ui: ui?.linkedResources?.blob?.image === true,
    },
    placement: ui?.placement ?? "none",
  };
}
