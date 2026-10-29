/** @file The deliberately small Dockerfile and `.dockerignore` forms image keys support. */
import { absurd } from "effect";
import path from "node:path";
import {
  ImageInputError,
  readJson,
  type Tree,
  under,
} from "./image-input-tree.ts";

/** What a runtime stage starts: a network service from `/app`, or the daemon launcher over its seed. */
export type DockerRuntime = "service" | "launcher";

/**
 * The launcher stage seeds the volume both containers mount, which the launcher
 * directory must own and every user must read.
 */
const LAUNCHER_STAGE: ReadonlySet<string> = new Set([
  "COPY --from=build --chown=node:node /deploy/ /opt/social-harness/launcher/seed/",
  'ENV PATH="/opt/social-harness/launcher/seed/node_modules/.bin:${PATH}"',
  "ENV SHARNESS_LAUNCHER_DIRECTORY=/opt/social-harness/launcher",
  "ENV SHARNESS_LAUNCHER_SEED=/opt/social-harness/launcher/seed",
  "ENV SHARNESS_LAUNCHER_PACKAGE=@moltzap/openclaw-channel",
  "RUN chown node:node /opt/social-harness/launcher && chmod -R a+rX /opt/social-harness/launcher/seed",
  'VOLUME ["/opt/social-harness/launcher"]',
  "USER node",
  'ENTRYPOINT ["sharnessd-launcher"]',
]);

/** Docker's ignore wildcards: `**` crosses directories, `*` and `?` stay within one. */
const IGNORE_WILDCARDS: ReadonlyMap<string, string> = new Map([
  ["**/", "(?:.*/)?"],
  ["**", ".*"],
  ["*", "[^/]*"],
  ["?", "[^/]"],
]);

/**
 * Inventories named context sources after validating every instruction.
 * Named roots are inventoried conservatively; ignore rules bind as a fixed input.
 * Stage copies consume the already inventoried build output.
 */
export function dockerContextInputs(
  tree: Tree,
  file: string,
  service: string,
  runtime: DockerRuntime,
): string[] {
  const inputs: string[] = [];
  let stage = 0;
  const commands = buildCommands(tree, service);
  const lines = tree
    .read(file)
    .split(/\r?\n/u)
    .map((raw, index) => ({
      file,
      number: index + 1,
      text: raw.trim(),
    }));
  for (const line of lines.filter((line) => !ignored(line.text))) {
    stage = instructionInputs(
      tree,
      line,
      { stage, service, runtime, commands },
      inputs,
    );
  }
  if (stage !== 2) {
    refuse({ file, number: lines.length, text: "expected two FROM stages" });
  }
  return inputs;
}

/**
 * Lists the files of a build context that its `.dockerignore` admits.
 * Docker's rules apply: the last matching pattern decides, `!` admits again,
 * a pattern that matches a directory covers its contents, and `*` matches
 * dotfiles. Character classes and escapes are refused rather than guessed.
 */
export function admittedContext(tree: Tree, directory: string): string[] {
  const file = `${directory}/.dockerignore`;
  const patterns = tree.files.has(file)
    ? tree
        .read(file)
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"))
        .map((line) => ignorePattern(file, line))
    : [];
  return under(tree, directory).filter((candidate) => {
    const relative = path.posix.relative(directory, candidate);
    return patterns.reduce(
      (admitted, { admits, matches }) =>
        ancestry(relative).some((entry) => matches.test(entry))
          ? admits
          : admitted,
      true,
    );
  });
}

interface DockerLine {
  readonly file: string;
  readonly number: number;
  readonly text: string;
}

interface DockerStage {
  readonly stage: number;
  readonly service: string;
  readonly runtime: DockerRuntime;
  readonly commands: ReadonlySet<string>;
}

function ignored(line: string): boolean {
  return (
    line === "" ||
    (line.startsWith("#") && !/^#\s*(?:syntax|escape)\s*=/iu.test(line))
  );
}

function buildCommands(tree: Tree, service: string): ReadonlySet<string> {
  const manager = readJson(tree, "package.json").packageManager;
  return new Set([
    `corepack enable && corepack prepare ${String(manager)} --activate`,
    `pnpm install --frozen-lockfile --filter ${service}...`,
    `pnpm nx run ${service}:build`,
    `pnpm deploy --filter ${service} --prod --legacy /deploy`,
  ]);
}

function instructionInputs(
  tree: Tree,
  line: DockerLine,
  state: DockerStage,
  inputs: string[],
): number {
  if (line.text.startsWith("FROM ")) {
    return nextStage(line, state.stage);
  }
  if (line.text.startsWith("COPY ") && state.stage === 1) {
    inputs.push(...contextCopy(tree, line));
  } else if (!allowedInstruction(line.text, state)) {
    refuse(line);
  }
  return state.stage;
}

function nextStage(line: DockerLine, stage: number): number {
  const pinned = /^FROM node:[\w.-]+@sha256:[a-f\d]{64}(?: AS build)?$/u.test(
    line.text,
  );
  if (
    !pinned ||
    stage >= 2 ||
    line.text.endsWith(" AS build") !== (stage === 0)
  ) {
    refuse(line);
  }
  return stage + 1;
}

function allowedInstruction(line: string, state: DockerStage): boolean {
  if (state.stage === 1) {
    return state.commands.has(line.slice(4))
      ? line.startsWith("RUN ")
      : [
          "WORKDIR /build",
          "ENV HUSKY=0 NX_DAEMON=false NX_NO_CLOUD=true",
        ].includes(line);
  }
  if (state.stage !== 2) {
    return false;
  }
  if (
    /^LABEL org\.opencontainers\.image\.(?:source|description)="[^"\\$`]+"$/u.test(
      line,
    )
  ) {
    return true;
  }
  switch (state.runtime) {
    case "service":
      return serviceStage(line, state.service);
    case "launcher":
      return LAUNCHER_STAGE.has(line);
    default:
      return absurd(state.runtime);
  }
}

function contextCopy(tree: Tree, line: DockerLine): string[] {
  const sources = line.text.slice(5).split(/\s+/u);
  const destination = sources.pop() ?? "";
  if (
    sources.length === 0 ||
    !sources.every(namedPath) ||
    !copyDestination(tree, sources, destination)
  ) {
    refuse(line);
  }
  return sources.flatMap((source) => copiedFiles(tree, source, line));
}

function copyDestination(
  tree: Tree,
  sources: readonly string[],
  destination: string,
): boolean {
  if (destination === "./") {
    return sources.every(
      (source) => !source.includes("/") && tree.files.has(source),
    );
  }
  return (
    sources.length === 1 &&
    namedPath(destination) &&
    destination.replace(/\/$/u, "") === sources[0]?.replace(/\/$/u, "")
  );
}

function copiedFiles(tree: Tree, source: string, line: DockerLine): string[] {
  const name = source.replace(/\/$/u, "");
  const files = [...tree.files.keys()].filter(
    (candidate) => candidate === name || candidate.startsWith(`${name}/`),
  );
  if (files.length === 0) {
    refuse(line);
  }
  return files.filter((candidate) => candidate !== "pnpm-lock.yaml");
}

function namedPath(value: string): boolean {
  return (
    /^[\w.-]+(?:\/[\w.-]+)*\/?$/u.test(value) &&
    value.split("/").every((segment) => segment !== "." && segment !== "..") &&
    !value.startsWith("-") &&
    path.posix.normalize(value) === value
  );
}

function serviceStage(line: string, service: string): boolean {
  const name = service.split("/").at(-1) ?? "";
  return (
    [
      "COPY --from=build /deploy/ /app/",
      "WORKDIR /app",
      "USER node",
      'ENV PATH="/app/node_modules/.bin:${PATH}"',
      `ENTRYPOINT ["/app/bin/sharness-${name}"]`,
    ].includes(line) ||
    /^EXPOSE [1-9]\d{0,4}$/u.test(line) ||
    new RegExp(
      `^ENV SHARNESS_${name.toUpperCase()}_HOST=0\\.0\\.0\\.0 SHARNESS_${name.toUpperCase()}_PORT=[1-9]\\d{0,4}$`,
      "u",
    ).test(line)
  );
}

function refuse(line: DockerLine): never {
  throw new ImageInputError({
    message: `Unsupported Dockerfile form in ${line.file} line ${line.number}: ${line.text}. Docs: https://github.com/social-harness/moltzap/blob/main/docs/reference/spec/layer-interfaces.md#unsupported-dockerfile-form`,
  });
}

function ignorePattern(
  file: string,
  line: string,
): { readonly admits: boolean; readonly matches: RegExp } {
  const admits = line.startsWith("!");
  const pattern = path.posix
    .normalize((admits ? line.slice(1) : line).trim().replace(/^\/+/u, ""))
    .replace(/\/$/u, "");
  if (/[[\]\\]/u.test(pattern)) {
    throw new ImageInputError({
      message: `Unsupported .dockerignore pattern in ${file}: ${line}. Docs: https://github.com/social-harness/moltzap/blob/main/docs/reference/spec/layer-interfaces.md#unsupported-dockerfile-form`,
    });
  }
  const source = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/u)
    .map(
      (part) =>
        IGNORE_WILDCARDS.get(part) ?? part.replace(/[.+^${}()|]/gu, "\\$&"),
    )
    .join("");
  return { admits, matches: new RegExp(`^${source}$`, "u") };
}

/** A path and each directory above it, since a pattern that matches a directory covers its contents. */
function ancestry(relative: string): string[] {
  const segments = relative.split("/");
  return segments.map((segment, index) =>
    [...segments.slice(0, index), segment].join("/"),
  );
}
