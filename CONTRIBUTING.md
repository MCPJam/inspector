# Contributing to MCPJam Inspector

First off, thank you for considering contributing to MCPJam Inspector! It's people like you that make the open source community such a great place.

## Finding an issue to work on

1. You can find things to work on in our [issues tab](https://github.com/MCPJam/inspector/issues).
2. Look for issues labelled `good first issue` and `very easy`. These are great starter tasks that are low commitment
3. Once you find an issue you like to work on, comment on the issue and tag @matteo8p. Then assign yourself the issue. This helps avoid multiple contributors working on the same issue.

## Getting Started

Before you get started, please consider giving the project a star ⭐. It helps grow the project and gives your contributions more recognition.

Also join our [Discord channel](https://discord.com/invite/JEnDtz8X6z). That's where the community and other open source contributors communicate on.

### Prerequisites

Make sure to have the following:

- [Node.js](https://nodejs.org/) (LTS version recommended)
- [npm](https://www.npmjs.com/) (comes with Node.js)

Also make sure to

- [Node.js](https://nodejs.org/) (LTS version recommended)
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

### Setup

Install the dependencies for all workspaces:

```bash
npm install
```

## Development

To run the client and server in development mode with hot-reloading, use:

```bash
npm run dev
```

For Windows users, there's a specific script:

```bash
npm run dev:windows
```

### Building the Project

To build all parts of the project (client, server, and cli), run:

```bash
npm run build
```

You can also build each part individually:

- `npm run build-client`
- `npm run build-server`
- `npm run build-cli`

## Testing

Before submitting your changes, please run the tests to ensure everything is working correctly.

```bash
npm test
```

This command will also check for any code formatting issues.

## Code Style

We use [Prettier](https://prettier.io/) to maintain a consistent code style. Before you commit your changes, please format your code by running:

```bash
npm run prettier-fix
```

## Commit Messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification. This helps us automate changelog generation and keep the commit history clean and readable.

Your commit messages should be structured as follows:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Example:**
`feat(client): add new button to the main component`
`fix(server): resolve issue with API endpoint`

## Pull Request Process

1.  Ensure all tests are passing (`npm test`).
2.  Make sure your code is formatted (`npm run prettier-fix`).
3.  Push your branch to your fork: `git push origin my-feature-branch`
4.  Open a **Pull Request** to the `main` branch of the original repository.
5.  In your PR description, please explain the changes you've made and link any relevant issues.

Thank you for your contribution!
