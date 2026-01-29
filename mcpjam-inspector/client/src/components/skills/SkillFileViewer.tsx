import { useMemo, useCallback } from "react";
import { RefreshCw, FileText, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { MemoizedMarkdown } from "@/components/chat-v2/thread/memomized-markdown";
import type { SkillFileContent } from "@shared/skill-types";

interface SkillFileViewerProps {
  file: SkillFileContent | null;
  loading?: boolean;
  error?: string;
  onLinkClick?: (path: string) => void;
  rawMode?: boolean;
}

/**
 * Get language identifier from MIME type for code blocks
 */
function getLanguageFromMime(mimeType: string, fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  const extToLang: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "fish",
    ps1: "powershell",
    sql: "sql",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    lua: "lua",
    r: "r",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    html: "html",
    htm: "html",
    css: "css",
    toml: "toml",
    ini: "ini",
  };

  return extToLang[ext] || "text";
}

/**
 * Wrap code content in a markdown code block for syntax highlighting
 */
function wrapAsCodeBlock(content: string, language: string): string {
  return "```" + language + "\n" + content + "\n```";
}

export function SkillFileViewer({
  file,
  loading,
  error,
  onLinkClick,
  rawMode = false,
}: SkillFileViewerProps) {
  // Handle clicks on links within markdown content
  const handleContentClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onLinkClick) return;

      const target = e.target as HTMLElement;
      const anchor = target.closest("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href) return;

      // Only intercept relative links (not external URLs)
      if (
        href.startsWith("http://") ||
        href.startsWith("https://") ||
        href.startsWith("//")
      ) {
        return;
      }

      e.preventDefault();
      onLinkClick(href);
    },
    [onLinkClick],
  );

  const handleDownload = () => {
    if (!file) return;

    const content = file.isText ? file.content : file.base64;
    if (!content) return;

    const blob = file.isText
      ? new Blob([content], { type: file.mimeType })
      : new Blob([Uint8Array.from(atob(content), (c) => c.charCodeAt(0))], {
          type: file.mimeType,
        });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Process markdown content - strip frontmatter for cleaner display (unless raw mode)
  const processedContent = useMemo(() => {
    if (!file?.content || !file.mimeType.includes("markdown")) return null;

    // In raw mode, show as code block with original content
    if (rawMode) {
      return wrapAsCodeBlock(file.content, "yaml");
    }

    let content = file.content;

    // Strip YAML frontmatter (content between --- at the start)
    if (content.startsWith("---")) {
      const endIndex = content.indexOf("---", 3);
      if (endIndex !== -1) {
        content = content.slice(endIndex + 3).trim();
      }
    }

    return content;
  }, [file, rawMode]);

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center mb-3">
          <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" />
        </div>
        <p className="text-xs text-muted-foreground font-semibold">
          Loading file...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6">
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium max-w-md text-center">
          {error}
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <FileText className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-xs text-muted-foreground">
          Select a file to view its content
        </p>
      </div>
    );
  }

  // Image files
  if (file.mimeType.startsWith("image/") && file.base64) {
    return (
      <ScrollArea className="h-full">
        <div className="p-6 flex items-center justify-center">
          <img
            src={`data:${file.mimeType};base64,${file.base64}`}
            alt={file.name}
            className="max-w-full max-h-[70vh] object-contain rounded-md border border-border"
          />
        </div>
      </ScrollArea>
    );
  }

  // Markdown files
  if (file.mimeType.includes("markdown") && file.content) {
    return (
      <ScrollArea className="h-full">
        <div
          onClick={handleContentClick}
          className={
            rawMode
              ? "p-4 min-w-max"
              : "p-6 prose prose-sm dark:prose-invert max-w-none"
          }
        >
          <MemoizedMarkdown content={processedContent || file.content} />
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    );
  }

  // Code/text files
  if (file.isText && file.content) {
    const language = getLanguageFromMime(file.mimeType, file.name);
    const codeBlock = wrapAsCodeBlock(file.content, language);

    return (
      <ScrollArea className="h-full">
        <div onClick={handleContentClick} className="p-4 min-w-max">
          <MemoizedMarkdown content={codeBlock} />
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    );
  }

  // Binary files (non-image)
  return (
    <div className="h-full flex flex-col items-center justify-center text-center p-6">
      <FileText className="h-12 w-12 text-muted-foreground/30 mb-4" />
      <p className="text-sm font-medium text-foreground mb-1">Binary File</p>
      <p className="text-xs text-muted-foreground mb-4">
        {file.mimeType} ({formatFileSize(file.size)})
      </p>
      <Button variant="outline" size="sm" onClick={handleDownload}>
        <Download className="h-3 w-3 mr-2" />
        Download File
      </Button>
    </div>
  );
}

/**
 * Format file size in human readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
