/** @file Committed Git snapshot and input decoding for image keys. */
import { Data, Effect, Either } from "effect";
import { spawnSync } from "node:child_process";
import path from "node:path";
/** A failed read or an incomplete committed input graph. */
export class ImageInputError extends Data.TaggedError("ImageInputError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Git identity of one committed input. */
export interface File {
  readonly mode: string;
  readonly blob: string;
}

/** A snapshot keeps traversal and hashing on the same committed revision. */
export interface Tree {
  readonly service?: string;
  readonly commandCwds?: Map<string, Set<string>>;
  readonly files: ReadonlyMap<string, File>;
  readonly read: (file: string) => string;
  readonly resolve: (file: string) => string;
}

/** Reads one committed revision and rejects unaccountable paths. */
export function checkout(repo: string): Tree {
  const files = new Map<string, File>();
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  for (const entry of git(repo, ["ls-tree", "-r", "-z", "--full-tree", head])
    .split("\0")
    .filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const header = entry.slice(0, tab);
    const file = entry.slice(tab + 1);
    const [mode = "", kind, blob = ""] = header.split(" ");
    if (kind === "blob" || mode === "160000") {
      files.set(file, { mode, blob });
    }
  }
  const cache = new Map<string, string>();
  const resolve = (file: string) =>
    treeTarget(
      file,
      files,
      (id) => cache.get(id) ?? git(repo, ["cat-file", "blob", id]),
      new Set(),
    );
  return {
    files,
    resolve,
    read: (file) => {
      const found = files.get(resolve(file));
      if (found === undefined) {
        throw new ImageInputError({
          message: `Missing committed input ${file}`,
        });
      }
      const text =
        cache.get(found.blob) ?? git(repo, ["cat-file", "blob", found.blob]);
      cache.set(found.blob, text);
      return text;
    },
  };
}

/** Preserves typed input failures across synchronous adapters. */
export function inputError(cause: unknown): ImageInputError {
  return cause instanceof ImageInputError
    ? cause
    : new ImageInputError({
        message:
          cause instanceof TypeError && cause.message.includes("encoded data")
            ? "Non-UTF-8 committed path in git ls-tree"
            : String(cause),
        cause,
      });
}

/** Indexes committed package identities without working-tree directories. */
export function workspaceRoots(tree: Tree): ReadonlyMap<string, string> {
  const roots = new Map<string, string>();
  for (const file of [...tree.files.keys()].filter((file) =>
    /^packages\/[^/]+\/package\.json$/u.test(file),
  )) {
    const name = String(readJson(tree, file).name);
    if (roots.has(name)) {
      throw new ImageInputError({
        message: `Duplicate workspace package name ${name} in ${file}`,
      });
    }
    roots.set(name, path.posix.dirname(file));
  }
  return roots;
}

/** Reads a committed JSON object. */
export function readJson(tree: Tree, file: string): Record<string, unknown> {
  return mapping(jsonValue(tree.read(file), file));
}

/** Parses strict JSON with a file-specific error. */
export function jsonValue(text: string, file: string): unknown {
  return Either.match(
    Effect.runSync(
      Effect.either(
        Effect.try({
          try: (): unknown => JSON.parse(text),
          catch: (cause) =>
            new ImageInputError({ message: `Invalid JSON in ${file}`, cause }),
        }),
      ),
    ),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (value) => value,
    },
  );
}

/** Narrows unknown values to object entries. */
export function mapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** Lists committed inputs below a directory. */
export function under(tree: Tree, root: string): string[] {
  return [...tree.files.keys()].filter((file) => file.startsWith(`${root}/`));
}

function git(repo: string, args: readonly string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Git is the release runner's installed Git.
  const result = spawnSync("git", args, {
    cwd: repo,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new ImageInputError({
      message: result.stderr?.toString("utf8") || String(result.error),
    });
  }
  if (args[0] === "ls-tree") {
    const decoded = new TextDecoder("utf-8", { fatal: true });
    return decoded.decode(result.stdout);
  }
  return result.stdout.toString("utf8");
}

function treeTarget(
  file: string,
  files: ReadonlyMap<string, File>,
  blob: (id: string) => string,
  seen: ReadonlySet<string>,
): string {
  const entry = files.get(file);
  if (entry === undefined || seen.has(file)) {
    throw new ImageInputError({
      message: `Missing or cyclic symlink image input ${file}`,
    });
  }
  if (entry.mode === "160000") {
    throw new ImageInputError({ message: `Unsupported gitlink input ${file}` });
  }
  if (entry.mode !== "120000") {
    return file;
  }
  const link = blob(entry.blob);
  const target = path.posix.isAbsolute(link)
    ? link
    : path.posix.normalize(path.posix.join(path.posix.dirname(file), link));
  if (target.startsWith("../") || path.posix.isAbsolute(target)) {
    throw new ImageInputError({
      message: `Outside-tree symlink image input ${file}`,
    });
  }
  return treeTarget(target, files, blob, new Set([...seen, file]));
}
