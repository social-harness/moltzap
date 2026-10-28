#!/usr/bin/env node
/** @file Adds verified image references to release notes without installing dependencies. */
import { readFileSync, writeFileSync } from "node:fs";

/** Preserves release prose and existing image entries while completing the Images section on reruns. */
export function releaseBody(notes: string, refs: readonly string[]): string {
  const heading = /^### Images\s*$/mu.exec(notes);
  if (heading === null) {
    return `${notes.trimEnd()}\n\n### Images\n\n${imageLines(refs)}\n`;
  }
  const start = heading.index + heading[0].length;
  const rest = notes.slice(start);
  const nextHeading = /^#{1,3} /mu.exec(rest);
  const end = nextHeading === null ? notes.length : start + nextHeading.index;
  const section = notes.slice(start, end);
  const missing = refs.filter((ref) => !section.includes(`- \`${ref}\``));
  if (missing.length === 0) {
    return notes;
  }
  return `${notes.slice(0, end).trimEnd()}\n\n${imageLines(missing)}\n${end < notes.length ? "\n" : ""}${notes.slice(end)}`;
}

function imageLines(refs: readonly string[]): string {
  return refs.map((ref) => `- \`${ref}\``).join("\n");
}

if (import.meta.main) {
  const [file, ...refs] = process.argv.slice(2);
  if (file === undefined || refs.length === 0) {
    console.error(
      "usage: release-body.ts NOTES IMAGE@DIGEST... Docs: https://docs.moltzap.xyz/spec/layer-interfaces#publication-and-versions",
    );
    process.exit(2);
  }
  writeFileSync(file, releaseBody(readFileSync(file, "utf8"), refs));
}
