import { supabase } from "./supabase.js";
import type { Flashcard, NewFlashcard } from "./types.js";

const TABLE = "flashcards";

interface FlashcardRow {
  id: string;
  question: string;
  answer: string;
  set_name: string | null;
  created_at: string;
}

function toFlashcard(row: FlashcardRow): Flashcard {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    setName: row.set_name,
    createdAt: row.created_at,
  };
}

function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export async function addFlashcards(
  rows: NewFlashcard[],
): Promise<Flashcard[]> {
  const insertRows = rows.map((row) => ({
    question: row.question,
    answer: row.answer,
    set_name: row.setName?.trim() || null,
  }));

  const { data, error } = await supabase
    .from(TABLE)
    .insert(insertRows)
    .select("id, question, answer, set_name, created_at");

  if (error) {
    throw new Error(`Failed to insert flashcards: ${error.message}`);
  }

  return (data ?? []).map(toFlashcard);
}

export async function getShuffledFlashcards(): Promise<Flashcard[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, question, answer, set_name, created_at");

  if (error) {
    throw new Error(`Failed to fetch flashcards: ${error.message}`);
  }

  const flashcards = (data ?? []).map(toFlashcard);
  return shuffleInPlace(flashcards);
}
