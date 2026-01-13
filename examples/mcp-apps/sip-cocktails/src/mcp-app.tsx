/**
 * @file Cocktail widget app using MCP Apps SDK + React.
 */
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import styles from "./mcp-app.module.css";

const IMPLEMENTATION = { name: "Cocktail Widget", version: "1.0.0" };
const DEFAULT_COCKTAIL_ID = "amaretto_sour";


const log = {
  info: console.log.bind(console, "[APP]"),
  warn: console.warn.bind(console, "[APP]"),
  error: console.error.bind(console, "[APP]"),
};

type ImageDoc = {
  _id: string;
  id: string;
  filename: string;
  contentType: string;
  storageId: string;
  uploadedAt: number;
  url: string | null;
};

type IngredientDoc = {
  _id: string;
  id: string;
  name: string;
  subName?: string;
  description: string;
  imageId: string;
  imageIds?: string[];
  image?: ImageDoc | null;
  images?: ImageDoc[];
};

type CocktailIngredient = {
  ingredientId: string;
  measurements: Record<string, number>;
  displayOverrides?: Record<string, string>;
  note?: string;
  optional?: boolean;
  ingredient: IngredientDoc;
};

type CocktailData = {
  _id: string;
  id: string;
  name: string;
  tagline: string;
  subName?: string;
  description: string;
  instructions: string;
  hashtags: string[];
  garnish?: string;
  nutrition: {
    abv: number;
    sugar: number;
    volume: number;
    calories: number;
  };
  image?: ImageDoc | null;
  ingredients: CocktailIngredient[];
};

function extractCocktail(callToolResult: CallToolResult): CocktailData | null {
  const structured = callToolResult.structuredContent as
    | { cocktail?: CocktailData }
    | undefined;
  return structured?.cocktail ?? null;
}


function CocktailApp() {
  const [cocktail, setCocktail] = useState<CocktailData | null>(null);
  const [status, setStatus] = useState("Loading cocktail...");
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const { app, error } = useApp({
    appInfo: IMPLEMENTATION,
    capabilities: {},
    onAppCreated: (app) => {
      app.onteardown = async () => {
        log.info("App is being torn down");
        return {};
      };
      app.ontoolinput = async (input) => {
        log.info("Received tool call input:", input);
      };

      app.onerror = log.error;

      app.onhostcontextchanged = (params) => {
        setHostContext((prev) => ({ ...prev, ...params }));
      };
    },
  });

  useEffect(() => {
    if (app) {
      setHostContext(app.getHostContext());
    }
  }, [app]);

  const loadCocktail = useCallback(async () => {
    if (!app) return;
    setStatus("Loading cocktail...");
    try {
      const result = await app.callServerTool({
        name: "get-cocktail",
        arguments: { id: DEFAULT_COCKTAIL_ID },
      });
      const data = extractCocktail(result);
      if (!data) {
        throw new Error("No cocktail returned from server.");
      }
      setCocktail(data);
    } catch (err) {
      log.error(err);
      setStatus("Failed to load cocktail.");
    }
  }, [app]);

  useEffect(() => {
    if (app) {
      loadCocktail();
    }
  }, [app, loadCocktail]);

  if (error) return <div className={styles.status}>Error: {error.message}</div>;
  if (!app) return <div className={styles.status}>Connecting...</div>;

  return (
    <CocktailAppInner
      cocktail={cocktail}
      status={status}
      hostContext={hostContext}
    />
  );
}


interface CocktailAppInnerProps {
  cocktail: CocktailData | null;
  status: string;
  hostContext?: McpUiHostContext;
}
function CocktailAppInner({ cocktail, status, hostContext }: CocktailAppInnerProps) {
  const ingredientRows = useMemo(() => {
    if (!cocktail) return [];
    return cocktail.ingredients.map((entry) => {
      const measurements = formatMeasurements(
        entry.measurements,
        entry.displayOverrides,
      );
      return {
        key: entry.ingredientId,
        name: entry.ingredient.name,
        subName: entry.ingredient.subName,
        imageUrl: entry.ingredient.image?.url ?? null,
        measurements,
        optional: entry.optional,
        note: entry.note,
      };
    });
  }, [cocktail]);

  return (
    <main
      className={styles.shell}
      style={{
        paddingTop: hostContext?.safeAreaInsets?.top,
        paddingRight: hostContext?.safeAreaInsets?.right,
        paddingBottom: hostContext?.safeAreaInsets?.bottom,
        paddingLeft: hostContext?.safeAreaInsets?.left,
      }}
    >
      <section className={styles.card}>
        {!cocktail ? (
          <div className={styles.status}>{status}</div>
        ) : (
          <>
            <header className={styles.header}>
              <span className={styles.kicker}>Signature Cocktail</span>
              <h1>{cocktail.name}</h1>
              <p className={styles.tagline}>{cocktail.tagline}</p>
            </header>

            <div className={styles.hero}>
              {cocktail.image?.url ? (
                <img
                  src={cocktail.image.url}
                  alt={cocktail.name}
                  className={styles.heroImage}
                />
              ) : (
                <div className={styles.heroFallback}>Image unavailable</div>
              )}
            </div>

            <div className={styles.details}>
              <p className={styles.description}>{cocktail.description}</p>
              <div className={styles.metaRow}>
                <span>{cocktail.instructions}</span>
              </div>
              {cocktail.garnish && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>Garnish</span>
                  <span>{cocktail.garnish}</span>
                </div>
              )}
            </div>

            <section className={styles.section}>
              <h2>Ingredients</h2>
              <ul className={styles.ingredientList}>
                {ingredientRows.map((item) => (
                  <li key={item.key} className={styles.ingredientItem}>
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt={item.name}
                        className={styles.ingredientImage}
                      />
                    ) : (
                      <div className={styles.ingredientImageFallback} />
                    )}
                    <div className={styles.ingredientInfo}>
                      <div className={styles.ingredientName}>
                        {item.name}
                        {item.subName ? (
                          <span className={styles.ingredientSubName}>
                            {item.subName}
                          </span>
                        ) : null}
                      </div>
                      <div className={styles.ingredientMeta}>
                        <span>{item.measurements}</span>
                        {item.optional ? (
                          <span className={styles.optional}>optional</span>
                        ) : null}
                      </div>
                      {item.note && (
                        <div className={styles.ingredientNote}>{item.note}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section className={styles.section}>
              <h2>Nutrition</h2>
              <div className={styles.nutritionGrid}>
                <div>
                  <span className={styles.metaLabel}>ABV</span>
                  <span>{cocktail.nutrition.abv}%</span>
                </div>
                <div>
                  <span className={styles.metaLabel}>Sugar</span>
                  <span>{cocktail.nutrition.sugar}g</span>
                </div>
                <div>
                  <span className={styles.metaLabel}>Volume</span>
                  <span>{cocktail.nutrition.volume}ml</span>
                </div>
                <div>
                  <span className={styles.metaLabel}>Calories</span>
                  <span>{cocktail.nutrition.calories}</span>
                </div>
              </div>
            </section>

            <footer className={styles.footer}>
              <div className={styles.tagRow}>
                {cocktail.hashtags.map((tag) => (
                  <span key={tag} className={styles.tag}>
                    #{tag}
                  </span>
                ))}
              </div>
            </footer>
          </>
        )}
      </section>
    </main>
  );
}

function formatMeasurements(
  measurements: Record<string, number>,
  overrides?: Record<string, string>,
) {
  const order = ["oz", "ml", "part"];
  const formatted = order
    .filter((unit) => measurements[unit] !== undefined)
    .map((unit) => overrides?.[unit] ?? `${measurements[unit]} ${unit}`);
  return formatted.join(" / ");
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CocktailApp />
  </StrictMode>,
);
