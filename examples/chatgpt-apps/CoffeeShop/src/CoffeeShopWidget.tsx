import { StrictMode, useState, useCallback, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useToolOutput } from "./hooks/useToolOutput";
import type { CoffeeToolOutput } from "./types";

const MAX_COFFEES = 10;

function CoffeeShopWidget() {
  const toolOutput = useToolOutput();
  const [state, setState] = useState<CoffeeToolOutput>(() => {
    // Initialize from toolOutput if available
    if (window.openai?.toolOutput) {
      return window.openai.toolOutput as CoffeeToolOutput;
    }
    return {
      coffeeCount: 0,
      message: "",
    };
  });

  // Sync state when toolOutput changes (e.g., from chat commands)
  const prevToolOutputRef = useRef<CoffeeToolOutput | undefined>(undefined);
  useEffect(() => {
    if (toolOutput && toolOutput !== prevToolOutputRef.current) {
      prevToolOutputRef.current = toolOutput;
      setState(toolOutput);
    }
  }, [toolOutput]);

  const handleOrder = useCallback(async () => {
    const result = await window.openai?.callTool("orderCoffee", {});
    if (result?.structuredContent) {
      setState(result.structuredContent);
    }
  }, []);

  const handleDrink = useCallback(async () => {
    const result = await window.openai?.callTool("drinkCoffee", {});
    if (result?.structuredContent) {
      setState(result.structuredContent);
    }
  }, []);

  const handleLearnMore = useCallback(() => {
    if (window.openai?.openExternal) {
      window.openai.openExternal({ href: "https://www.mcpjam.com" });
    } else {
      window.open("https://www.mcpjam.com", "_blank");
    }
  }, []);

  const isError =
    state.message.toLowerCase().includes("sorry") ||
    state.message.toLowerCase().includes("no coffee");

  return (
    <div className="w-full max-w-[400px]">
      <div className="flex items-center gap-3 pb-4 border-b border-gray-200 mb-6">
        <span className="text-3xl">☕️</span>
        <span className="text-2xl font-semibold text-gray-900">Coffee Shop</span>
      </div>

      <div className="grid grid-cols-5 gap-2 mb-6">
        {Array.from({ length: MAX_COFFEES }).map((_, i) => (
          <div
            key={i}
            className={`aspect-square flex items-center justify-center text-3xl rounded-xl transition-all ${
              i < state.coffeeCount
                ? "bg-orange-50"
                : "bg-gray-100 border-2 border-dashed border-gray-300"
            }`}
          >
            {i < state.coffeeCount ? "☕️" : ""}
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <button
          onClick={handleOrder}
          className="flex-1 py-3.5 px-5 text-base font-semibold rounded-xl cursor-pointer transition-all flex items-center justify-center gap-2 bg-coffee text-white hover:bg-coffee-dark active:scale-[0.98]"
        >
          <span>Order</span>
          <span>☕️</span>
        </button>
        <button
          onClick={handleDrink}
          className="flex-1 py-3.5 px-5 text-base font-semibold rounded-xl cursor-pointer transition-all flex items-center justify-center gap-2 bg-gray-100 text-gray-700 hover:bg-gray-200 active:scale-[0.98]"
        >
          <span>Drink</span>
          <span>☕️</span>
        </button>
      </div>

      <div
        className={`text-center mt-4 p-2.5 text-sm font-medium min-h-[20px] rounded-lg transition-all ${
          state.message
            ? isError
              ? "bg-red-50 text-red-700"
              : "bg-green-50 text-green-700"
            : "text-gray-500"
        }`}
      >
        {state.message}
      </div>

      <button
        onClick={handleLearnMore}
        className="w-full mt-4 py-2 px-4 text-sm text-coffee hover:text-coffee-dark underline cursor-pointer transition-all"
      >
        Learn more at MCPJam
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CoffeeShopWidget />
  </StrictMode>
);
