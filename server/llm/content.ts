/**
 * Message-content coercion for OpenAI-compatible upstream responses.
 *
 * Vendored (minimal adaptation) from FreeLLMAPI `server/src/lib/content.ts`
 * — see PROVENANCE.md. Some providers return `message.content` as an array
 * of content blocks instead of a plain string; we join the text blocks and
 * drop everything else (no vision/audio in this project).
 */

export function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        const block = b as { type?: string; text?: unknown };
        // OpenAI blocks carry type:'text'; some Gemini-lineage providers send
        // part-style `{ text }` with no type at all — accept any block whose
        // `text` is a string and whose type doesn't say it's something else.
        if (
          typeof block?.text === "string" &&
          (block.type === "text" || block.type === undefined)
        ) {
          return block.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}
