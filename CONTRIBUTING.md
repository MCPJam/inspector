# Contributing

First off, thank you for considering contributing to MCPJam Inspector! It's people like you that make the open source community such a great place.

## Finding an issue to work on

1. You can find things to work on in our [issues tab](https://github.com/MCPJam/inspector/issues).
2. Look for issues labelled `good first issue` and `very easy`. These are great starter tasks that are low commitment.
3. Once you find an issue you like to work on, comment on the issue and tag @matteo8p. Then assign yourself the issue. This helps avoid multiple contributors working on the same issue.

## Getting Started

Before you get started, please consider giving the project a star. It helps grow the project and gives your contributions more recognition.

Also join our [Discord channel](https://discord.com/invite/JEnDtz8X6z). That's where the community and other open source contributors communicate.

### Prerequisites

- [Node.js](https://nodejs.org/) **v22 or higher**
- [npm](https://www.npmjs.com/) (comes with Node.js)

### Fork, Clone, and Branch

1.  **Fork** the repository on GitHub.
2.  **Clone** your fork locally:
    ```bash
    git clone https://github.com/YOUR_USERNAME/inspector.git
    cd inspector
    ```
3.  Create a new **branch** for your changes:
    ```bash
    git checkout -b my-feature-branch
    ```

### Project Structure

This is an **npm workspaces monorepo**. The main packages are:

| Workspace | Package | Description |
|-----------|---------|-------------|
| `mcpjam-inspector/` | `@mcpjam/inspector` | Inspector app (client, server, Electron) |
| `sdk/` | `@mcpjam/sdk` | MCP SDK for testing and evals |
| `cli/` | `@mcpjam/cli` | CLI tool |
| `design-system/` | `@mcpjam/design-system` | Shared UI components |
| `soundcheck/` | `@mcpjam/soundcheck` | Soundcheck app |
| `mcp/` | `@mcpjam/mcp` | MCP worker |

Most contributions target the `mcpjam-inspector/` workspace.

### Setup

Install dependencies for all workspaces from the repo root:

```bash
npm install
```

## Development

Copy the env file inside the inspector workspace:

```bash
cp mcpjam-inspector/.env.local mcpjam-inspector/.env.development
```

Then start the inspector in dev mode:

```bash
npm run dev -w @mcpjam/inspector
```

This runs:

- **Client**: Vite dev server on `:5173`
- **Server**: Hono dev server on `:6274`

Open `http://localhost:5173` in your browser. The client proxies API requests to the server.

### Electron Development

To run the Electron app in development mode:

```bash
npm run electron:dev -w @mcpjam/inspector
```

This runs:

- Electron main process
- Embedded Hono server
- Vite dev server for renderer

### Building the Project

To build everything (SDK, CLI, and Inspector):

```bash
npm run build
```

To build individual workspaces:

- `npm run build -w @mcpjam/sdk` - Build the SDK
- `npm run build -w @mcpjam/cli` - Build the CLI
- `npm run build -w @mcpjam/inspector` - Build the Inspector

To start the production build locally:

```bash
npm run start -w @mcpjam/inspector
```

### Running Tests

Run all tests and type checks:

```bash
npm run verify
```

Or run tests for a specific workspace:

```bash
npm run test -w @mcpjam/inspector
npm run test -w @mcpjam/sdk
npm run test -w @mcpjam/cli
```

## Code Style

We use [Prettier](https://prettier.io/) to maintain a consistent code style. Before you commit your changes, please format your code by running:

```bash
npm run prettier-fix -w @mcpjam/inspector
```

## Commit Messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification. This helps us keep the commit history clean and readable.

Your commit messages should be structured as follows:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Example:**
`feat(client): add new button to the main component`
`fix(server): resolve issue with API endpoint`

## Getting Help

- [Discord](https://discord.com/invite/JEnDtz8X6z)
- [Docs](https://docs.mcpjam.com)

Thank you for your contribution!
