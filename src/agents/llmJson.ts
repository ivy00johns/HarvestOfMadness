/**
 * Defensive JSON extraction for cognition responses (reflection questions /
 * insights are JSON ARRAYS; src/llm/parse.ts only extracts objects). Same
 * policy as §4.2: tolerate prose/fences, take the first balanced block,
 * never throw — garbage yields null and the caller falls back to the mock.
 */

/**
 * First balanced top-level `[...]` substring, string-aware (brackets inside
 * JSON strings don't count), or null when none closes.
 */
export function extractFirstJsonArray(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse a JSON array of non-empty strings from raw model text (cap optional). */
export function parseStringArray(raw: string, cap?: number): string[] {
  const json = extractFirstJsonArray(raw);
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out = parsed.filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    return cap !== undefined ? out.slice(0, cap) : out;
  } catch {
    return [];
  }
}

export interface ParsedInsight {
  insight: string;
  sourceIds: string[];
}

/**
 * Parse a JSON array of {insight, sourceIds} objects; sourceIds are filtered
 * to `knownIds` (reflections may only cite memories that exist), entries
 * without a usable insight string are dropped, result capped at `cap`.
 */
export function parseInsights(
  raw: string,
  knownIds: ReadonlySet<string>,
  cap: number,
): ParsedInsight[] {
  const json = extractFirstJsonArray(raw);
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: ParsedInsight[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const insight = typeof rec.insight === "string" ? rec.insight.trim() : "";
      if (!insight) continue;
      const sourceIds = Array.isArray(rec.sourceIds)
        ? rec.sourceIds.filter(
            (s): s is string => typeof s === "string" && knownIds.has(s),
          )
        : [];
      out.push({ insight, sourceIds });
      if (out.length >= cap) break;
    }
    return out;
  } catch {
    return [];
  }
}
