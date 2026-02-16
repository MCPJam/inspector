export interface Flashcard {
  id: string;
  question: string;
  answer: string;
  setName: string | null;
  createdAt: string;
}

export interface NewFlashcard {
  question: string;
  answer: string;
  setName?: string;
}
