# Dev command with MCPJam

An MCP server whose `npm run dev` opens MCPJam with the server connected, using the `@mcpjam/inspector/vite` plugin. Copy this setup into your own SDK or framework's `dev` command.

```bash
npm install
npm run dev
```

1. Vite serves the `greeter` MCP server at `http://127.0.0.1:3001/mcp` (set `PORT` to change it). It is on Vite's own port, so there is nothing else to bind.
2. The plugin starts MCPJam on port 6274 and opens it, or reuses the MCPJam you already have open.
3. Sign in if asked. MCPJam adds `greeter` to the project your tab shows, connects it and selects it. If your tabs show different projects, it asks which one.
4. Open **Tools**, pick `greet`, enter a name and run it.

Edit `server.ts` or `vite.config.ts` and Vite restarts: MCPJam stays up and `greeter` keeps its entry. Stop `npm run dev` and MCPJam removes `greeter`. Run a second project's `npm run dev` at the same time and both servers share one MCPJam, which stops after the last dev command quits.

Without Vite, call `launchInspector()` from `@mcpjam/inspector` with the same `server` and `reuse: true`. See [Launch from Code](https://docs.mcpjam.com/inspector/launch-from-code).
