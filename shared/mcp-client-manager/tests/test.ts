import { MCPClientManager } from '../index.js';

async function main() {
  const manager = new MCPClientManager({
    demo: {
      url: new URL("http://localhost:8000/mcp"),
    },
  });

  console.log(await manager.listTools("demo"));
}

main().catch(error => {
  console.error('Test run failed:', error);
  process.exitCode = 1;
});
