import { protectedResourceMetadataUrls } from "../../metadata-candidates.js";

export function buildResourceMetadataUrl(serverUrl: string): string {
  return protectedResourceMetadataUrls(serverUrl)[0];
}
