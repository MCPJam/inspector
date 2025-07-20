import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "MCPJam",
  version: packageJson.version,
  copyright: `© ${currentYear}, MCPJam.`,
  meta: {
    title: "MCPJam",
    description:
      "MCPJam is a testing and debugging tool for MCP servers. Postman for MCP.",
  },
};
