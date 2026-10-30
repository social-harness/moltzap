/** @file Text content carried by ordinary collective protocol records. */
import type { Content } from "../records/values.js";

/**
 * A message's content as the text a model reads: each text part as written,
 * each data part as JSON, one part per line.
 * @param content The delivered message's content.
 * @returns The text a host puts in the model's turn.
 */
export function renderContent(content: Content): string {
  return content
    .map((part) =>
      part.type === "text" ? part.text : (JSON.stringify(part.value) ?? "null"),
    )
    .join("\n");
}

/**
 * A request message's question as every member's model reads it: its text
 * parts, one per line. The collective part is a data part, so it is never
 * among them.
 * @param content The request message's content.
 * @returns The text parts, joined by newlines.
 */
export function questionText(content: Content): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}
