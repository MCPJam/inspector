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
