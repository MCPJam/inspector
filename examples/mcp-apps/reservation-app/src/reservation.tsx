import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";

const IMPLEMENTATION = { name: "Reservation App", version: "1.0.0" };

function ReservationApp() {
  const { app, error } = useApp({
    appInfo: IMPLEMENTATION,
    capabilities: {},
  });

  const handleMenuRequest = useCallback(async () => {
    if (!app) return;
    try {
      await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: `What's on the menu at Jammy Wammy?` }],
      });
    } catch (e) {
      console.error("Failed to send message:", e);
    }
  }, [app]);

  if (error) return <div><strong>ERROR:</strong> {error.message}</div>;
  if (!app) return <div>Loading...</div>;

  return (
    <main style={{
      padding: "20px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      maxWidth: "600px",
      margin: "0 auto"
    }}>
      <h1 style={{ fontSize: "24px", marginBottom: "16px" }}>
        🎉 Reservation Confirmed!
      </h1>
      
      <p style={{ fontSize: "16px", marginBottom: "24px" }}>
        Your table at <strong>Jammy Wammy</strong> is ready!
      </p>

      <button
        onClick={handleMenuRequest}
        style={{
          padding: "12px 24px",
          fontSize: "16px",
          backgroundColor: "#007bff",
          color: "white",
          border: "none",
          borderRadius: "6px",
          cursor: "pointer",
          fontWeight: "500"
        }}
      >
        What's on the menu?
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ReservationApp />
  </StrictMode>,
);
