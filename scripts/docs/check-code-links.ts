#!/usr/bin/env node
/**
 * @file Code docs-link gate. Every `https://docs.moltzap.xyz/<page>#<anchor>`
 * that an error or help text in a package's `src` names must resolve to a
 * page under `docs/` and to a heading or `<a id>` on it.
 *
 * `mint broken-links` checks links between pages, not the strings code
 * prints, so an anchor renamed in a guide would leave every `Docs:` link to
 * it dead without failing anything. Links are found in three spellings: a
 * whole literal, a constant holding a page (`const GUIDE = "https://…"`) used
 * as `${GUIDE}#anchor`, and a constant that already holds its anchor. A
 * heading resolves by its slug: lowercased, punctuation other than `-` and
 * `_` dropped, spaces turned into `-`.
 *
 * Exit codes: 0 every link resolves, 1 a page or anchor is missing.
 *
 * Wired into `pnpm lint` via the workspace `lint:docs-links` target.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SITE = "https://docs.moltzap.xyz/";

// eslint-disable-next-line sonarjs/no-os-command-from-path -- Developer tooling intentionally resolves installed commands through the caller’s PATH.
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

interface Link {
  readonly file: string;
  readonly page: string;
  readonly anchor: string;
}

function main(): void {
  const files = tracked(":(glob)packages/*/src/**/*.ts");
  const sources = files.map((file) => ({
    file,
    text: readFileSync(join(repoRoot, file), "utf8"),
  }));
  const pages = pageConstants(sources.map((source) => source.text));
  const links = sources.flatMap((source) =>
    linksIn(source.file, source.text, pages),
  );
  const broken = links.filter((link) => !resolves(link));
  if (broken.length === 0) {
    console.log(
      `[check-code-links] PASS — ${links.length} docs link(s) in ${files.length} source file(s) resolve.`,
    );
    process.exit(0);
  }
  console.error("[check-code-links] FAIL\n");
  for (const link of broken) {
    console.error(
      `  ${link.file}: ${SITE}${link.page}#${link.anchor} names no heading or <a id> in docs/${link.page}`,
    );
  }
  process.exit(1);
}

function tracked(pattern: string): readonly string[] {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Developer tooling intentionally resolves installed commands through the caller’s PATH.
  return execFileSync("git", ["-C", repoRoot, "ls-files", pattern], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => path.length > 0);
}

/** Constants whose value is a docs page without an anchor, by name. */
function pageConstants(texts: readonly string[]): ReadonlyMap<string, string> {
  const pages = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(
      /const\s+([A-Z][A-Z0-9_]*)\s*=\s*"https:\/\/docs\.moltzap\.xyz\/([a-z0-9/_-]+)"/gu,
    )) {
      pages.set(match[1] ?? "", match[2] ?? "");
    }
  }
  return pages;
}

function linksIn(
  file: string,
  text: string,
  pages: ReadonlyMap<string, string>,
): readonly Link[] {
  const literal = [
    ...text.matchAll(
      /https:\/\/docs\.moltzap\.xyz\/([a-z0-9/_-]+)#([A-Za-z0-9_-]+)/gu,
    ),
  ].map((match) => ({
    file,
    page: match[1] ?? "",
    anchor: match[2] ?? "",
  }));
  const composed = [
    ...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}#([A-Za-z0-9_-]+)/gu),
  ].flatMap((match) => {
    const page = pages.get(match[1] ?? "");
    return page === undefined
      ? []
      : [{ file, page, anchor: match[2] ?? "" }];
  });
  return [...literal, ...composed];
}

function resolves(link: Link): boolean {
  const page = [".mdx", ".md"]
    .map((extension) => join(repoRoot, "docs", `${link.page}${extension}`))
    .find((path) => existsSync(path));
  return page !== undefined && anchors(page).has(link.anchor);
}

/** A page's explicit `<a id>` anchors and its headings' slugs, outside code fences. */
function anchors(page: string): ReadonlySet<string> {
  const found = new Set<string>();
  let fenced = false;
  for (const line of readFileSync(page, "utf8").split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
    } else if (!fenced) {
      for (const match of line.matchAll(/<a\s+id="([^"]+)"/gu)) {
        found.add(match[1] ?? "");
      }
      const heading = /^#{1,6}\s+(.+)$/u.exec(line);
      if (heading !== null) {
        found.add(slug(heading[1] ?? ""));
      }
    }
  }
  return found;
}

function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/gu, "-");
}

main();
