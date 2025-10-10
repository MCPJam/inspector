import { MCPClientManager } from '../index.js';

async function main() {
  const manager = new MCPClientManager({
    // asana: {
    //     url: new URL("https://mcp.asana.com/sse"),
    //     requestInit: {
    //         headers: {
    //             Authorization: "Bearer 1211605246745101:1feupt88QAfTxFIX:zrwh9My0XEjI3cS7ABIj48Q8hVvNFXcD"
    //         }
    //     },
    // },
    everything: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
    }
  });
  console.log(await manager.listTools("everything"));
  console.log(await manager.disconnectServer("everything"))
  console.log(await manager.listServers())
}

main().catch(error => {
  console.error('Test run failed:', error);
});
