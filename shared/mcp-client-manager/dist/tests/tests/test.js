import { MCPClientManager } from '../index.js';
async function main() {
    const manager = new MCPClientManager({
        everything: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-everything"],
        }
    });
    console.log((await manager.listTools("everything")).tools[0].inputSchema);
}
main().catch(error => {
    console.error('Test run failed:', error);
});
