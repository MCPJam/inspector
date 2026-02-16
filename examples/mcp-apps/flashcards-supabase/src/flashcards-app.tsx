import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import styles from "./flashcards-app.module.css";
import "./global.css";
import type { Flashcard } from "./lib/types.js";

const IMPLEMENTATION = { name: "Flashcards Study App", version: "1.0.0" };

function isFlashcard(value: unknown): value is Flashcard {
  if (!value || typeof value !== "object") {
    return false;
  }

  const card = value as Record<string, unknown>;
  return (
    typeof card.id === "string" &&
    typeof card.question === "string" &&
    typeof card.answer === "string" &&
    (typeof card.setName === "string" || card.setName === null) &&
    typeof card.createdAt === "string"
  );
}

function extractFlashcards(result: CallToolResult | null): Flashcard[] {
  if (!result) {
    return [];
  }

  const structured = (
    result as { structuredContent?: { flashcards?: unknown } }
  ).structuredContent;
  if (!structured?.flashcards || !Array.isArray(structured.flashcards)) {
    return [];
  }

  return structured.flashcards.filter(isFlashcard);
}

function FlashcardsApp() {
  const [hostContext, setHostContext] = useState<McpUiHostContext>();
  const [flashcards, setFlashcards] = useState<Flashcard[]>([]);
  const [index, setIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const { app, isConnected, error } = useApp({
    appInfo: IMPLEMENTATION,
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = async (result) => {
        setFlashcards(extractFlashcards(result));
        setIndex(0);
        setIsFlipped(false);
        setIsBusy(false);
      };

      createdApp.ontoolinput = async () => {
        setIsBusy(true);
      };

      createdApp.onhostcontextchanged = (context) => {
        setHostContext((previous) => ({ ...previous, ...context }));
      };

      createdApp.onerror = (sdkError) => {
        console.error(sdkError);
        setIsBusy(false);
      };

      createdApp.onteardown = async () => {
        return {};
      };
    },
  });

  useEffect(() => {
    if (app) {
      setHostContext(app.getHostContext());
    }
  }, [app]);

  const currentCard = flashcards[index] ?? null;

  const flipCard = useCallback(() => {
    if (!currentCard) {
      return;
    }
    setIsFlipped((value) => !value);
  }, [currentCard]);

  const showNext = useCallback(() => {
    if (flashcards.length === 0) {
      return;
    }
    setIsFlipped(false);
    setIndex((value) => (value + 1) % flashcards.length);
  }, [flashcards.length]);

  const showPrevious = useCallback(() => {
    if (flashcards.length === 0) {
      return;
    }
    setIsFlipped(false);
    setIndex((value) => (value - 1 + flashcards.length) % flashcards.length);
  }, [flashcards.length]);

  if (error) {
    return (
      <div>
        <strong>ERROR:</strong> {error.message}
      </div>
    );
  }

  if (!app || !isConnected) {
    return <div>Connecting to flashcards app...</div>;
  }

  return (
    <main
      className={styles.main}
      style={{
        paddingTop: (hostContext?.safeAreaInsets?.top ?? 0) + 16,
        paddingRight: (hostContext?.safeAreaInsets?.right ?? 0) + 16,
        paddingBottom: (hostContext?.safeAreaInsets?.bottom ?? 0) + 16,
        paddingLeft: (hostContext?.safeAreaInsets?.left ?? 0) + 16,
      }}
    >
      {!currentCard ? (
        <p className={styles.empty}>No flashcards yet.</p>
      ) : (
        <section className={styles.study}>
          <button
            type="button"
            className={styles.navButton}
            onClick={showPrevious}
            disabled={isBusy}
            aria-label="Previous flashcard"
          >
            ←
          </button>

          <div className={styles.cardRail}>
            <button
              type="button"
              className={`${styles.card} ${isFlipped ? styles.cardFlipped : ""}`}
              onClick={flipCard}
              aria-label="Flip flashcard"
            >
              <article className={styles.face}>
                <p className={styles.sideLabel}>Question</p>
                <p className={styles.sideText}>{currentCard.question}</p>
              </article>

              <article className={`${styles.face} ${styles.back}`}>
                <p className={styles.sideLabel}>Answer</p>
                <p className={styles.sideText}>{currentCard.answer}</p>
              </article>
            </button>

            <p className={styles.counter}>
              {index + 1} / {flashcards.length}
            </p>
          </div>

          <button
            type="button"
            className={styles.navButton}
            onClick={showNext}
            disabled={isBusy}
            aria-label="Next flashcard"
          >
            →
          </button>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FlashcardsApp />
  </StrictMode>,
);
