create extension if not exists pgcrypto;

create table if not exists public.flashcards (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  set_name text,
  created_at timestamptz not null default now()
);

comment on table public.flashcards is 'Stores flashcard question/answer pairs for MCP flashcard study sessions.';
comment on column public.flashcards.set_name is 'Optional set label (for example: US state capitals).';
