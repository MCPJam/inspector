import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  pluginMessageDraft,
  type PluginMessageDraft,
  type PluginMessageIntent,
} from "@/shared/plugin-message";
import type { ContextAttachment } from "../chat-v2/chat-input/attachments/context-attachment-chip";
import {
  createFileAttachment,
  validateFile,
  type FileAttachment,
} from "../chat-v2/chat-input/attachments/file-utils";

/** One message holds at most 64 blocks; the composer holds no more items. */
const DRAFT_ITEMS_MAX = 64;

type DraftItem = PluginMessageDraft["items"][number];
const NO_ITEMS: readonly DraftItem[] = [];

/** Untitled draft text joins whatever the person already typed. */
export function appendDraftText(current: string, text: string) {
  if (!text) return current;
  return current.trim() ? `${current.trimEnd()}\n\n${text}` : text;
}

/** Image bytes as composer attachments, or null when any fails the
 * composer's own file checks (the draft is then refused whole). */
export function draftImageAttachments(
  images: PluginMessageDraft["images"],
): FileAttachment[] | null {
  const files = images.map((image, index) => {
    const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
    const name =
      image.filename ??
      `app-image-${index + 1}.${image.mimeType.slice("image/".length)}`;
    return new File([bytes], name, { type: image.mimeType });
  });
  if (files.some((file) => !validateFile(file).valid)) return null;
  return files.map(createFileAttachment);
}

/**
 * What an App's editable draft (`ui/message` with `send: false`) leaves in
 * the composer. Untitled text joins the editable input and images join the
 * file attachments; titled text, resource links and embedded resources stay
 * whole as removable items whose parts go out with the person's next send.
 * Items belong to one chat (`key`): another chat shows none, as composer
 * mentions do.
 */
export function useAppMessageDraft(
  key: string,
  composer: {
    input: string;
    setInput: (value: string) => void;
    setFileAttachments: Dispatch<SetStateAction<FileAttachment[]>>;
  },
) {
  const [state, setState] = useState<{
    key: string;
    items: readonly DraftItem[];
  }>({ key, items: NO_ITEMS });
  const items = state.key === key ? state.items : NO_ITEMS;
  const remove = useCallback(
    (index: number) =>
      setState((old) =>
        old.key === key
          ? { key, items: old.items.filter((_, i) => i !== index) }
          : old,
      ),
    [key],
  );
  const clear = useCallback(() => setState({ key, items: NO_ITEMS }), [key]);
  /** Places the whole draft or nothing. Nothing executes. */
  const place = async (intent: PluginMessageIntent) => {
    const draft = pluginMessageDraft(intent.params);
    const images = draftImageAttachments(draft.images);
    if (!images || items.length + draft.items.length > DRAFT_ITEMS_MAX)
      return false;
    if (draft.text)
      composer.setInput(appendDraftText(composer.input, draft.text));
    if (images.length)
      composer.setFileAttachments((old) => [...old, ...images]);
    if (draft.items.length)
      setState((old) => ({
        key,
        items: [...(old.key === key ? old.items : []), ...draft.items],
      }));
    return true;
  };
  const parts = useMemo(() => items.map((item) => item.part), [items]);
  const contextAttachments = useMemo(
    (): ContextAttachment[] =>
      items.map((item, index) => ({
        id: `app-message:${index}`,
        title: item.title,
        description: "Added by an App",
        remove: () => remove(index),
      })),
    [items, remove],
  );
  return { items, parts, contextAttachments, place, clear };
}
