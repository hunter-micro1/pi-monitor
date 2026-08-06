/**
 * Shared message-text extraction.
 *
 * Both supported harnesses represent message bodies as a list of
 * typed content blocks with `{ type: "text", text: "..." }` among
 * them, so preview extraction is common code rather than per-adapter
 * logic. Claude additionally allows a bare string for user messages
 * (a plain typed prompt), which `firstTextPreview` handles too.
 */

/**
 * Cap on the text preview captured per record. The UI truncates
 * further to fit the row width; this bound just keeps an absurdly
 * long single text block from bloating the cached snapshot.
 *
 * Mirrors `_PREVIEW_MAX_CHARS` in the Python build.
 */
export const PREVIEW_MAX_CHARS = 200;

/** Shape of a content block we care about. */
type ContentItem = {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
};

function cap(text: string): string | null {
  const stripped = text.replace(/^\s+/, "");
  if (stripped.length === 0) return null;
  return stripped.length > PREVIEW_MAX_CHARS
    ? stripped.slice(0, PREVIEW_MAX_CHARS)
    : stripped;
}

/**
 * First usable text chunk of a block-list `content`, lstripped and
 * capped at `PREVIEW_MAX_CHARS`. Returns `null` when no usable text
 * is present (tool-only turn, all-whitespace text, malformed shape).
 *
 * Strictly array-only, including for a bare string: pi emits
 * `content` as a string for entries that carry no displayable text,
 * so treating a string as a preview would surface junk in the row.
 * Harnesses where a bare string IS the message body (Claude) should
 * use `textPreview` instead.
 */
export function firstTextPreview(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  for (const item of content as ContentItem[]) {
    if (typeof item !== "object" || item === null) continue;
    if (item.type !== "text") continue;
    const text = item.text;
    if (typeof text !== "string") continue;
    const capped = cap(text);
    if (capped !== null) return capped;
  }
  return null;
}

/**
 * Like `firstTextPreview`, but also accepts a bare string as the
 * message body.
 *
 * Claude Code stores a plainly-typed user prompt as
 * `message.content: "do the thing"` rather than a one-element text
 * block, so its adapter needs the string case. pi does not — see the
 * note on `firstTextPreview`.
 */
export function textPreview(content: unknown): string | null {
  if (typeof content === "string") return cap(content);
  return firstTextPreview(content);
}
