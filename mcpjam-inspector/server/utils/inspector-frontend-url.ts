import { SERVER_HOSTNAME, SERVER_PORT } from "../config.js";

export interface InspectorFrontendUrlOptions {
  isElectron?: boolean;
  isPackaged?: boolean;
  isProduction?: boolean;
}

export function getInspectorFrontendUrl(
  options: InspectorFrontendUrlOptions = {},
): string {
  const explicitFrontendUrl =
    process.env.MCPJAM_INSPECTOR_FRONTEND_URL?.trim() ||
    process.env.FRONTEND_URL?.trim();
  if (explicitFrontendUrl) {
    return explicitFrontendUrl;
  }

  const isElectron = options.isElectron ?? process.env.ELECTRON_APP === "true";
  const isPackaged = options.isPackaged ?? process.env.IS_PACKAGED === "true";
  const isProduction =
    options.isProduction ?? process.env.NODE_ENV === "production";

  if (isProduction || (isElectron && isPackaged)) {
    return (
      process.env.BASE_URL?.trim() ||
      `http://${SERVER_HOSTNAME}:${SERVER_PORT}`
    );
  }

  if (isElectron) {
    return "http://localhost:8080";
  }

  return `http://localhost:${process.env.CLIENT_PORT || "5173"}`;
}
