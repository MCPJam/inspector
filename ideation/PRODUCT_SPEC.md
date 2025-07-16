# MCPJam Product Spec (Building v.1.0.0)
We're seeing a meteoric rise of interest in Model Context Protocol (MCP) and developers building MCP servers. The protocol is in its early stages, and dev tooling for MCP developers is still a very pre-mature space. There's an opportunity to build really good dev tooling for the MCP dev tool community. Good dev tooling lowers the barrier to entry for MCP devs, accelerating the growth and interest in this space. Since we started working on the MCPJam inspector, we've nearly reached 400 stars on GitHub and an active community of contributors. Many MCP devs I've spoken prefer to use MCPJam over other dev tools. 

However, I think MCPJam is far from being a mature product. This document outlines our plan to build an enterprise-grade open source MCP dev tool for the MCP community. Our v1.0.0 release. 

#### We want this to be a community project
MCPJam wouldn't be where its at right now without the help of the MCP community and their contributions. Please contribute your ideas to this doc, your ideas are greatly appreciated. If you're interested in contributing to this doc or the project, follow follow instructions in our [CONTRIBUTING.md](https://github.com/MCPJam/inspector/blob/main/CONTRIBUTING.md). We communicate on [Discord](https://discord.com/invite/Gpv7AmrRc4). 

https://www.mcpjam.com/

## Product Requirements 
A high quality MCP testing and debugging tool must have the following specs. This covers the inspector GUI and CLI support. 
<details>
<summary><strong>Smooth connection experience</strong></summary>

- Connections must support STDIO, SSE, and Streamable HTTP. SSE and Streamable connection experience is unified. 
- STDIO connections must support remote packages, like running `npx @modelcontextprotocol/server-everything`, and local files like running `node dist/index.js`. Any CLI command works
- Remote connections must support the entire [OAuth spec](https://modelcontextprotocol.io/specification/draft/basic/authorization) such as Dynamic Client Registration. 
- For all connections, we must be able to configure timeouts. For STDIO, allow user to add environment variables. For SSE/HTTP, allow the user to configure headers like Bearer tokens. 
- A really simple interface for configuring connections. MCPJam must be friendly for novice developers. 
- Must support the ability to connect to multiple MCP servers. Ability to edit, delete, duplicate connections. 
- Connections are saved on local storage and restored on project load, along with its authorization info if applicable
- Ability to disconnect and reconnect from an MCP server
- The ability to load in a `mcp.json` file? Not sure how useful this is, but some may find it easier to load / paste in their pre-existing mcp config file

</details>

<details>
<summary><strong>Implements the entire protocol</strong></summary>

  - ([Tool Calling](https://modelcontextprotocol.io/docs/concepts/tools)) Spec compliant to tool use. Provide a GUI to allow user to functionally test their tools. Uses correct MCP error handling. 
-  ([Prompts](https://modelcontextprotocol.io/docs/concepts/prompts)) Support for displaying prompts. User can function test displaying prompts. 
-  ([Roots](https://modelcontextprotocol.io/docs/concepts/roots)) Allow the MCP inspector, which acts as a client, to expose roots to any server it connects to. 
-  ([Resources](https://modelcontextprotocol.io/docs/concepts/resources)) Allow the MCP inspector to load resources from an MCP server 
-  ([Sampling](https://modelcontextprotocol.io/docs/concepts/sampling)) Sampling would only work within the playground because it needs an LLM. 
-  ([Elicitation](https://modelcontextprotocol.io/docs/concepts/elicitation)) We can test for elicitation in both the functional tests and in LLM playground. 

Few MCP clients have the spec fully implemented. MCPJam should be one of the first to be entirely spec compliant

</details> 

<details>
<summary><strong>Smooth testing and debugging experience</strong></summary>

- Properly error handles on connection issues and server implementation issues. 
- Start off building MCP testing frameworks, with automated functional testing for tool calls.  
- Full logs from the client and proxy server are displayed and copyable on the UI.

</details> 

<details>
<summary><strong>Simple navigation UI</strong></summary>

This project must be friendly for developers novice to MCP. MCPJam is an education tool as much as it is a testing tool. To do this, the UI cannot be cluttered, presenting ideally just one CTA at every page.

</details> 

<details>
<summary><strong>CLI Shortcuts & CLI Mode</strong></summary>

- Calling `npx @mcpjam/inspector node build/index.js` on the root directory of a JS MCP server for example, opens up the inspector with the server pre-loaded. 
- Same shortcut to connect to MCP servers using SSE/HTTP bu running `npx @mpcpjam/inspector sse http://localhost:3000/mcp` for example. 
- Support for the entire experience of [CLI mode](https://github.com/modelcontextprotocol/inspector?tab=readme-ov-file#cli-mode) of the original inspector. This is useful for automating common triggers.

</details> 




## Other Topics
#### Why not directly work on Anthropic's inspector? 
We've been asked this several times by people in the community: "why don't you contribute directly to [@modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)"? The reason why we decided to build our own is because we think the speed of progress made on Anthropic's inspector hasn't caught up to the speed of changes in the protocol, and the dev community's needs. Approvals for PRs are really slow, and a lot of parts of the protocol haven't been implemented. Anthropic's project lacks clear direction. We want to build faster and implement the protocol as it changes. 