import {
  createContext,
  isValidElement,
  useCallback,
  useContext,
  type ComponentProps,
  type ReactNode,
} from "react";
import { defaultComponents } from "streamdown";
import { parsePluginDeepLink } from "@/shared/plugin-deep-link";
import {
  FileLink,
  useResourceLinkIndex,
  type ResourceLinkTarget,
} from "@/components/host-workspace/file-actions";

/** Opens a plugin deep link (`chatgpt://`, `codex://`, chatgpt.com) in its App. */
export interface ChatDeepLinkActions {
  open: (url: string) => void;
}
const ChatDeepLinkContext = createContext<ChatDeepLinkActions | null>(null);

export function ChatDeepLinkProvider({
  value,
  children,
}: {
  value: ChatDeepLinkActions | null;
  children: ReactNode;
}) {
  return (
    <ChatDeepLinkContext.Provider value={value}>
      {children}
    </ChatDeepLinkContext.Provider>
  );
}

export function isPluginDeepLink(url: string): boolean {
  try {
    parsePluginDeepLink(url);
    return true;
  } catch {
    return false;
  }
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return textOf(node.props.children);
  return "";
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeLabel = (value: string) => value.replace(/([\\[\]])/g, "\\$1");

/** Fragment hrefs survive markdown sanitizing; the real target stays here. */
const LINK_PREFIX = "#mcpjam-link-";

const DEEP_LINK_TEXT =
  /(?:codex|chatgpt):\/\/plugins\/[^\s)\]>]+|https:\/\/chatgpt\.com\/plugins\/[^\s)\]>]+/g;
const MARKDOWN_TOKENS =
  /(`[^`\n]*`)|\[((?:\\.|[^\[\]\\])*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)|<([a-z][a-z0-9+.-]*:[^>\s]+)>/gi;

/**
 * Rewrites the links a chat handles itself: resource URIs this chat's tools
 * produced (shown by file name, never by URI) and plugin deep links. Each
 * becomes a fragment link whose target is kept in `targets`.
 */
export function rewriteChatLinks(
  content: string,
  links: Readonly<Record<string, ResourceLinkTarget>>,
  deepLinks: boolean,
): { content: string; targets: string[] } {
  const targets: string[] = [];
  const handled = (url: string) =>
    !!links[url] || (deepLinks && isPluginDeepLink(url));
  const linkTo = (label: string, url: string) => {
    targets.push(url);
    return `[${label}](${LINK_PREFIX}${targets.length - 1})`;
  };
  if (/^\s*(```|~~~)/.test(content)) return { content, targets };
  const uris = Object.keys(links)
    .filter((uri) => content.includes(uri))
    .sort((a, b) => b.length - a.length);
  const bare = uris.length
    ? new RegExp(uris.map(escapeRegExp).join("|"), "g")
    : null;
  const plain = (text: string) => {
    let next = bare
      ? text.replace(bare, (uri) =>
          linkTo(escapeLabel(links[uri]?.name ?? uri), uri),
        )
      : text;
    if (deepLinks)
      next = next.replace(DEEP_LINK_TEXT, (url) =>
        isPluginDeepLink(url) ? linkTo(escapeLabel(url), url) : url,
      );
    return next;
  };
  let out = "";
  let last = 0;
  for (const match of content.matchAll(MARKDOWN_TOKENS)) {
    out += plain(content.slice(last, match.index));
    last = match.index! + match[0].length;
    const [whole, code, label, href, autolink] = match;
    if (code !== undefined) out += whole;
    else if (href !== undefined)
      out += handled(href) ? linkTo(label, href) : whole;
    else if (autolink !== undefined)
      out += handled(autolink)
        ? linkTo(escapeLabel(links[autolink]?.name ?? autolink), autolink)
        : whole;
    else out += whole;
  }
  return { content: out + plain(content.slice(last)), targets };
}

/**
 * Markdown link handling for a chat that has plugin extensions: files the
 * chat's tools produced open their viewer and plugin deep links open their
 * App. `null` when neither applies, so other surfaces render as before.
 */
export function useChatMarkdownLinks() {
  const links = useResourceLinkIndex();
  const deepLinks = useContext(ChatDeepLinkContext);
  const prepare = useCallback(
    (content: string) => {
      const rewritten = rewriteChatLinks(content, links, !!deepLinks);
      if (!rewritten.targets.length) return null;
      const DefaultLink = defaultComponents.a as (
        props: ComponentProps<"a">,
      ) => ReactNode;
      const a = (props: ComponentProps<"a">) => {
        const href = typeof props.href === "string" ? props.href : "";
        const index = href.startsWith(LINK_PREFIX)
          ? Number(href.slice(LINK_PREFIX.length))
          : NaN;
        const url = Number.isInteger(index)
          ? rewritten.targets[index]
          : undefined;
        if (!url) return <DefaultLink {...props} />;
        const target = links[url];
        if (target) {
          const text = textOf(props.children).trim();
          return (
            <FileLink
              reference={{ serverId: target.serverId, resourceUri: url }}
              label={!text || text === url ? target.name : props.children}
            />
          );
        }
        return (
          <button
            type="button"
            className="text-primary underline underline-offset-2"
            title={url}
            onClick={() => deepLinks?.open(url)}
          >
            {props.children}
          </button>
        );
      };
      return { content: rewritten.content, components: { a } };
    },
    [links, deepLinks],
  );
  return Object.keys(links).length || deepLinks ? prepare : null;
}
