/**
 * @file Cocktail widget app using MCP Apps SDK + React.
 */
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CocktailData } from "./lib/types";
import styles from "./cocktail-recipe-widget.module.css";

const IMPLEMENTATION = { name: "Cocktail Widget", version: "1.0.0" };


const log = {
  info: console.log.bind(console, "[APP]"),
  warn: console.warn.bind(console, "[APP]"),
  error: console.error.bind(console, "[APP]"),
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
  const [cocktailId, setCocktailId] = useState<string | null>(null);
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
        const id = typeof input.arguments?.id === "string" ? input.arguments.id : null;
        log.info("Received tool call input:", input);
        if (id) {
          setCocktailId(id);
          setCocktail(null);
          setStatus(`Loading ${id}...`);
        }
      };

      app.ontoolresult = async (result) => {
        log.info("Received tool call result:", result);
        if (result.isError) {
          setStatus("Failed to load cocktail.");
          return;
        }
        const data = extractCocktail(result);
        if (!data) {
          setStatus("No cocktail returned from server.");
          return;
        }
        setCocktail(data);
      };

      app.ontoolcancelled = async (params) => {
        log.warn("Tool call cancelled:", params);
        setStatus("Cocktail request cancelled.");
      };

      app.onerror = log.error;

      app.onhostcontextchanged = (params) => {
        log.info("Host context changed:", params);
        setHostContext((prev) => ({ ...prev, ...params }));
      };
    },
  });

  useEffect(() => {
    if (app) {
      setHostContext(app.getHostContext());
    }
  }, [app]);

  useEffect(() => {
    const vars = hostContext?.styles?.variables;
    if (!vars) return;
    Object.entries(vars).forEach(([key, value]) => {
      if (value != null) {
        document.documentElement.style.setProperty(key, value);
      }
    });
  }, [hostContext?.styles?.variables]);

  useEffect(() => {
    if (app && !cocktailId) {
      setStatus("Waiting for tool input...");
    }
  }, [app, cocktailId]);

  if (error) return <div className={styles.status}>Error: {error.message}</div>;
  if (!app) return <div className={styles.status}>ChatGPT app not yet implemented.</div>;

  return (
    <CocktailAppInner
      cocktail={cocktail}
      status={status}
      hostContext={hostContext}
    />
  );
}


type MeasurementUnit = "oz" | "ml" | "part";

interface CocktailAppInnerProps {
  cocktail: CocktailData | null;
  status: string;
  hostContext?: McpUiHostContext;
}
function CocktailAppInner({ cocktail, status, hostContext }: CocktailAppInnerProps) {
  const [selectedUnit, setSelectedUnit] = useState<MeasurementUnit>("oz");

  const ingredientRows = useMemo(() => {
    if (!cocktail) return [];
    return cocktail.ingredients.map((entry) => {
      const measurements = formatMeasurement(
        entry.measurements,
        entry.displayOverrides,
        selectedUnit,
      );
      return {
        key: entry.ingredientId,
        name: entry.ingredient.name,
        subName: entry.ingredient.subName,
        imageUrl: entry.ingredient.image?.url ?? null,
        measurements,
        optional: entry.optional,
      };
    });
  }, [cocktail, selectedUnit]);

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

            <header className={styles.header}>
              <h1 className={styles.title}>{cocktail.name}</h1>
              <p className={styles.subtitle}>{cocktail.tagline}</p>
            </header>

            <section className={styles.section}>
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
                      <span className={styles.ingredientName}>{item.name}</span>
                      {item.subName ? (
                        <span className={styles.ingredientSubName}>
                          {item.subName}
                        </span>
                      ) : null}
                      {item.optional ? (
                        <span className={styles.optional}>optional</span>
                      ) : null}
                    </div>
                    <span className={styles.ingredientMeasure}>
                      {item.measurements || "—"}
                    </span>
                  </li>
                ))}
              </ul>
              <div className={styles.unitToggle}>
                {(["oz", "ml", "part"] as const).map((unit) => (
                  <button
                    key={unit}
                    className={`${styles.unitButton} ${selectedUnit === unit ? styles.unitButtonActive : ""}`}
                    onClick={() => setSelectedUnit(unit)}
                  >
                    {unit}
                  </button>
                ))}
              </div>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Instructions</h2>
              <p className={styles.instructions}>{cocktail.instructions}</p>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Info</h2>
              <p className={styles.description}>{cocktail.description}</p>
              <div className={styles.metaLine}>
                {cocktail.garnish ? `Garnish: ${cocktail.garnish}` : "No garnish"}
                {` • ${cocktail.nutrition.abv}% ABV`}
                {` • ${cocktail.nutrition.volume}ml`}
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}

function formatMeasurement(
  measurements: Record<string, number>,
  overrides?: Record<string, string>,
  unit: MeasurementUnit = "oz",
) {
  if (measurements[unit] === undefined) {
    return null;
  }
  return overrides?.[unit] ?? `${measurements[unit]} ${unit}`;
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CocktailApp />
  </StrictMode>,
);
