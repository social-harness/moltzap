/**
 * @file Resolved Nx graph rules of the architecture boundary check.
 *
 * CI supplies the graph Nx calculated. Keeping the Nx invocation outside the
 * check avoids starting Nx recursively when the same checks run as an Nx
 * target, while still comparing the graph Nx actually resolved.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  dependencyNames,
  FINAL_PACKAGE_DIRS,
  FINAL_PACKAGE_NAMES,
  FINAL_PACKAGES,
  INTEGRATION_TESTS,
  type PackageDir,
} from "./boundary-contract.ts";
import {
  arrayAt,
  type BoundaryRun,
  failOnSetDrift,
  isJsonObject,
  type JsonObject,
  MalformedBoundaryInput,
  objectAt,
  readJsonObject,
  relativePath,
  stringAt,
} from "./boundary-run.ts";

/** The decoded graph and the label every failure about it carries. */
interface NxGraph {
  readonly label: string;
  readonly nodes: JsonObject;
  readonly dependencies: JsonObject;
}

/** A tool project outside `packages/`: its root, required targets, and edges. */
interface ToolProject {
  readonly name: string;
  readonly root: string;
  readonly targets: readonly string[];
  readonly dependencies: readonly PackageDir[];
  readonly toolDependencies?: readonly string[];
}

/** Tool roots share the same graph contract in enforcement and gate fixtures. */
export const TOOL_PROJECTS: readonly ToolProject[] = [
  INTEGRATION_TESTS,
  ...["image-tests", "openclaw-agent", "nanoclaw-agent"].map((folder) => ({
    name: `@social-harness/${folder}`,
    root: folder === "image-tests" ? "images/tests" : `images/${folder}`,
    targets:
      folder === "image-tests"
        ? ["test:live", "typecheck", "lint"]
        : ["test", "test:live", "typecheck", "lint"],
    toolDependencies:
      folder === "image-tests" ? [] : ["@social-harness/image-tests"],
    dependencies:
      folder === "image-tests"
        ? (["client", "registry", "router", "openclaw-channel"] as const)
        : ([] as const),
  })),
  {
    name: "workspace",
    root: "tools/workspace",
    targets: ["lint", "lint:architecture-boundaries"],
    dependencies: [],
  },
];

/**
 * Resolve the `--nx-graph` argument, if present, and check that graph.
 * @param run Run collecting failures.
 * @param argv Process arguments after the script path.
 */
export function checkNxGraphArgument(
  run: BoundaryRun,
  argv: readonly string[],
): void {
  const flag = argv.indexOf("--nx-graph");
  if (flag === -1) {
    return;
  }
  const graphFile = argv[flag + 1];
  if (graphFile === undefined) {
    run.failures.push("--nx-graph requires a project-graph JSON path");
  } else if (existsSync(graphFile)) {
    checkNxGraph(run, path.resolve(graphFile));
  } else {
    run.failures.push(`${graphFile}: Nx project graph does not exist`);
  }
}

/**
 * Compare a resolved Nx project graph against the final-package contract.
 * @param run Run collecting failures.
 * @param graphFile Absolute path of `nx graph --print` output.
 */
function checkNxGraph(run: BoundaryRun, graphFile: string): void {
  const label = relativePath(run, graphFile);
  const graph = readJsonObject(graphFile).graph;
  if (!isJsonObject(graph) || !isJsonObject(graph.nodes)) {
    run.failures.push(`${label}: not an Nx project graph`);
    return;
  }
  const nxGraph: NxGraph = {
    label,
    nodes: graph.nodes,
    dependencies: objectAt(graph, "dependencies"),
  };
  failOnSetDrift(run, {
    where: label,
    what: "Nx project nodes drifted",
    actual: Object.keys(nxGraph.nodes),
    wanted: [...FINAL_PACKAGE_NAMES, ...TOOL_PROJECTS.map(({ name }) => name)],
  });
  for (const dir of FINAL_PACKAGE_DIRS) {
    checkProductNode(run, nxGraph, dir);
  }
  for (const tool of TOOL_PROJECTS) {
    checkToolNode(run, nxGraph, tool);
  }
}

function checkProductNode(
  run: BoundaryRun,
  graph: NxGraph,
  dir: PackageDir,
): void {
  const { npmName, targets } = FINAL_PACKAGES[dir];
  const node = graph.nodes[npmName];
  if (!isJsonObject(node)) {
    run.failures.push(`${graph.label}: missing Nx project "${npmName}"`);
    return;
  }
  const data = objectAt(node, "data");
  const root = stringAt(data, "root");
  if (root !== `packages/${dir}`) {
    run.failures.push(
      `${graph.label}: Nx project "${npmName}" root is "${root ?? "missing"}", expected "packages/${dir}"`,
    );
  }
  const resolvedTargets = Object.keys(objectAt(data, "targets"));
  const missingTargets = targets.filter(
    (target) => !resolvedTargets.includes(target),
  );
  if (missingTargets.length > 0) {
    run.failures.push(
      `${graph.label}: Nx project "${npmName}" is missing required targets: ${missingTargets.join(", ")}`,
    );
  }
  if (!Array.isArray(graph.dependencies[npmName])) {
    run.failures.push(
      `${graph.label}: Nx dependency entry for "${npmName}" is missing`,
    );
    return;
  }
  failOnSetDrift(run, {
    where: graph.label,
    what: `Nx dependencies for "${npmName}" violate the final DAG`,
    actual: dependencyTargets(graph, npmName),
    wanted: dependencyNames(dir),
  });
}

function checkToolNode(
  run: BoundaryRun,
  graph: NxGraph,
  tool: ToolProject,
): void {
  const data = nodeData(graph, tool.name);
  const root = stringAt(data, "root");
  if (root !== tool.root) {
    run.failures.push(
      `${graph.label}: Nx project "${tool.name}" root is "${root ?? "missing"}", expected "${tool.root}"`,
    );
  }
  for (const target of tool.targets) {
    if (!Object.hasOwn(objectAt(data, "targets"), target)) {
      run.failures.push(
        `${graph.label}: Nx project "${tool.name}" is missing required target "${target}"`,
      );
    }
  }
  failOnSetDrift(run, {
    where: graph.label,
    what: `Nx dependencies for "${tool.name}" drifted`,
    actual: dependencyTargets(graph, tool.name),
    wanted: [
      ...tool.dependencies.map((dir) => FINAL_PACKAGES[dir].npmName),
      ...(tool.toolDependencies ?? []),
    ],
  });
}

function nodeData(graph: NxGraph, project: string): JsonObject {
  return objectAt(objectAt(graph.nodes, project), "data");
}

function dependencyTargets(graph: NxGraph, project: string): readonly string[] {
  return arrayAt(graph.dependencies, project).map((entry) => {
    if (!isJsonObject(entry) || typeof entry.target !== "string") {
      throw new MalformedBoundaryInput({
        message: `Malformed Nx dependency entry for ${project}: expected an object with a string target`,
      });
    }
    return entry.target;
  });
}
