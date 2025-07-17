import type { Metadata } from "next";
import "./globals.css";
import { McpProvider } from "./context/McpContext";

export const metadata: Metadata = {
  title: "MCPJam Inspector - Mastra Edition",
  description: "Model Context Protocol inspector powered by Mastra",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
        <McpProvider>
          {children}
        </McpProvider>
      </body>
    </html>
  );
}