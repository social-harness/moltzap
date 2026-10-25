/** @file The deliberately small Dockerfile language supported by image keys. */
import path from "node:path";
import { ImageInputError, readJson, type Tree } from "./image-input-tree.ts";

/**
 * Inventories named context sources after validating every instruction.
 * No Docker ignore rules apply: context-wide sources and globbing are refused.
 * Stage copies consume the already inventoried build output.
 */
export function dockerContextInputs(
  tree: Tree,
  file: string,
  service: string,
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
    stage = instructionInputs(tree, line, { stage, service, commands }, inputs);
  }
  if (stage !== 2) {
    refuse({ file, number: lines.length, text: "expected two FROM stages" });
  }
  return inputs;
}

interface DockerLine {
  readonly file: string;
  readonly number: number;
  readonly text: string;
}

interface DockerStage {
  readonly stage: number;
  readonly service: string;
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
  if (state.stage === 1 && state.commands.has(line.slice(4))) {
    return line.startsWith("RUN ");
  }
  if (
    state.stage === 2 &&
    line === "COPY --from=build --chown=node:node /deploy/ /app/"
  ) {
    return true;
  }
  return allowedMetadata(line, state.stage, state.service);
}

function contextCopy(tree: Tree, line: DockerLine): string[] {
  const sources = line.text.slice(5).split(/\s+/u);
  const destination = sources.pop() ?? "";
  const validDestination =
    destination === "./" || namedPath(destination.replace(/^\//u, ""));
  if (sources.length === 0 || !sources.every(namedPath) || !validDestination) {
    refuse(line);
  }
  return sources.flatMap((source) => copiedFiles(tree, source, line));
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

function allowedMetadata(
  line: string,
  stage: number,
  service: string,
): boolean {
  if (stage === 1) {
    return [
      "WORKDIR /build",
      "ENV HUSKY=0 NX_DAEMON=false NX_NO_CLOUD=true",
    ].includes(line);
  }
  if (stage !== 2) {
    return false;
  }
  const name = service.split("/").at(-1) ?? "";
  return (
    [
      "WORKDIR /app",
      "USER node",
      'ENV PATH="/app/node_modules/.bin:${PATH}"',
      `ENTRYPOINT ["/app/bin/sharness-${name}"]`,
    ].includes(line) ||
    /^EXPOSE [1-9]\d{0,4}$/u.test(line) ||
    /^LABEL org\.opencontainers\.image\.(?:source|description)="[^"\\$`]+"$/u.test(
      line,
    ) ||
    new RegExp(
      `^ENV SHARNESS_${name.toUpperCase()}_HOST=0\\.0\\.0\\.0 SHARNESS_${name.toUpperCase()}_PORT=[1-9]\\d{0,4}$`,
      "u",
    ).test(line)
  );
}

function refuse(line: DockerLine): never {
  throw new ImageInputError({
    message: `Unsupported Dockerfile form in ${line.file} line ${line.number}: ${line.text}. Docs: https://github.com/social-harness/moltzap/blob/main/docs/spec/layer-interfaces.md#unsupported-dockerfile-form`,
  });
}
