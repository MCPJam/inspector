import { MCPClientManager } from "../index.js";

async function main() {
  const manager = new MCPClientManager(
    {
      everything: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
    },
    {
      rpcLogger: ({ direction, message, serverId }) => {
        console.log(direction, message, serverId);
      },
    },
  );
  // console.log(await manager.listTools("everything"));
}

main().catch((error) => {
  console.error("Test run failed:", error);
});
