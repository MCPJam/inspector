# XAA Debugger walkthrough — screenshot shot list

The guide at `docs/guides/debug-xaa-cross-app-access.mdx` references the images
below. Capture them at ~1440px wide, light theme, and drop the PNGs in this
folder with these **exact** names.

To reproduce the states: run the toy server (`examples/mcp-servers/xaa-demo`,
`npm start`) and `npx @mcpjam/inspector@latest`, then follow the guide.

| File | Guide section | What to capture |
| --- | --- | --- |
| `01-inspector-home.png` | 1. Set up | Inspector just opened, no server connected. |
| `02-add-server.png` | 1. Set up | Add-server dialog filled in: URL `http://localhost:8080/mcp`, Type HTTP, Authentication = Cross-App Access, Client ID `demo-client`. |
| `03-run-all-failed.png` | 2. Trigger the failure | XAA Flow tab after **Run all**: the sequence diagram with the final step red + the "MCP server rejected the access token" card. |
| `04-inspect-token.png` | 3. Inspect the trace | The failed authenticated-MCP-request HTTP entry expanded, decoded access token visible with the `aud` field. |
| `05-mismatch.png` | 4. Find the root cause | The token `aud` (`http://localhost:8080/mcp`) and the server's required audience (`https://demo.example.com/mcp`) highlighted side by side. Can be a composited/annotated shot of the token + the server's startup line. |
| `06-fix.png` | 5. Apply the fix | Terminal showing the server restarted with `CANONICAL_URL=http://localhost:8080/mcp` and the new `audience required: http://localhost:8080/mcp` startup line. |
| `07-run-all-green.png` | 6. Re-run and verify | XAA Flow tab after the fix: all steps green, the MCP call succeeded. |

Until the PNGs are added, the guide renders with broken image slots — that's
expected; they're placeholders.
