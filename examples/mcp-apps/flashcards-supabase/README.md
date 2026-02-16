# Flashcards Supabase MCP App

A TypeScript MCP app that stores flashcards in Supabase and renders a minimal interactive flashcard UI.

## What this project does

The server exposes two MCP tools:

- `add_flashcards`: insert one or more `{ question, answer, setName? }` entries into Supabase.
- `view_flashcards`: fetch all flashcards, shuffle them randomly, and open the UI.

The UI is intentionally simple:

- white card with black mono text
- click card to flip question/answer
- left/right buttons to navigate cards

## Project structure

```text
flashcards-supabase/
├── server.ts                    # MCP server and tool/resource registration
├── server-utils.ts              # Streamable HTTP MCP transport setup (/mcp)
├── flashcards-app.html          # Vite HTML entrypoint for the UI bundle
├── src/
│   ├── flashcards-app.tsx       # React flashcard UI (flip + prev/next)
│   ├── flashcards-app.module.css
│   ├── global.css
│   └── lib/
│       ├── flashcards-db.ts     # DB read/write + shuffle logic
│       ├── supabase.ts          # Supabase client initialization from env
│       └── types.ts             # Shared flashcard types
├── supabase/
│   └── schema.sql               # SQL schema for public.flashcards
├── .env.example                 # Required env var template
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your Supabase project and table

In Supabase Dashboard:

1. Create a new project.
2. Open SQL Editor.
3. Run the SQL from `supabase/schema.sql`.

This creates `public.flashcards` with:

- `id` (uuid primary key)
- `question` (text)
- `answer` (text)
- `set_name` (text, optional)
- `created_at` (timestamp)

### 3. Configure environment variables

```bash
cp .env.example .env
```

Set values in `.env`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Note: env files are gitignored (`.env`, `.env.*`) while `.env.example` stays tracked.

### 4. Build the UI bundle

```bash
npm run build
```

### 5. Run the MCP server (Streamable HTTP)

```bash
set -a
source .env
set +a
npm run serve
```

Default endpoint:

- `http://localhost:3001/mcp`

Set a custom port:

```bash
PORT=8787 npm run serve
```

### Optional: run stdio mode

```bash
npm run serve:stdio
```

## Scripts

- `npm run build`: type-check and build single-file UI bundle to `dist/flashcards-app.html`
- `npm run serve`: run Streamable HTTP MCP server
- `npm run serve:stdio`: run stdio MCP server
- `npm run dev`: watch UI build + run server

## Notes

- `view_flashcards` always returns randomized card order.
- The server uses a Supabase service role key because tool calls write directly to the database.
