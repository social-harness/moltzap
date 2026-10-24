/** @file Contract-conforming graph mutations for the boundary gate. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  FINAL_PACKAGES,
  INTEGRATION_TESTS,
} from "../architecture/boundary-contract.ts";
import { TOOL_PROJECTS } from "../architecture/boundary-nx-graph.ts";
type GateAssertion = (name: string, passed: boolean, message: string) => void;
type GateRunner = (args: readonly string[]) => { code: number; stderr: string };

/** The graph checker validates resolved targets and edges, independently of manifests. */
export function testIntegrationGraph(
  test: GateAssertion,
  runNode: GateRunner,
  workspaceRoot: string,
): void {
  const graph = makeContractGraph();
  const temporary = mkdtempSync(resolve(tmpdir(), "sharness-graph-"));
  const file = resolve(temporary, "graph.json");
  const check = () => {
    writeFileSync(file, JSON.stringify({ graph }));
    return runNode([
      resolve(workspaceRoot, "scripts/architecture/check-boundaries.ts"),
      "--nx-graph",
      file,
    ]);
  };
  try {
    const clean = check();
    test("contract-conforming Nx graph passes", clean.code === 0, clean.stderr);
    const integration = graph.nodes[INTEGRATION_TESTS.name];
    if (integration === undefined) {
      throw new Error("integration graph node missing");
    }
    delete integration.data.targets["test:integration"];
    const missing = check();
    test(
      "Nx graph rejects missing integration target",
      missing.code === 1 &&
        /missing required target "test:integration"/.test(missing.stderr),
      missing.stderr,
    );
    integration.data.targets["test:integration"] = {};
    graph.dependencies[INTEGRATION_TESTS.name]?.push({
      source: INTEGRATION_TESTS.name,
      target: "@moltzap/nanoclaw-channel",
      type: "static",
    });
    const drift = check();
    test(
      "Nx graph rejects extra integration product edge",
      drift.code === 1 &&
        /Nx dependencies for "@moltzap\/integration-tests" drifted/.test(
          drift.stderr,
        ),
      drift.stderr,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** A synthetic graph isolates graph enforcement from Nx inference. */
function makeContractGraph() {
  const projects = contractProjects();
  return {
    nodes: Object.fromEntries(
      projects.map((project) => [
        project.name,
        {
          data: {
            root: project.root,
            targets: Object.fromEntries(
              project.targets.map((target) => [target, {}]),
            ),
          },
        },
      ]),
    ),
    dependencies: Object.fromEntries(
      projects.map((project) => [
        project.name,
        project.dependencies.map((target) => ({
          source: project.name,
          target,
          type: "static",
        })),
      ]),
    ),
  };
}

/** Products and tool roots have independently specified targets and edges. */
function contractProjects() {
  const products = Object.entries(FINAL_PACKAGES).map(([dir, contract]) => ({
    name: contract.npmName,
    root: `packages/${dir}`,
    targets: contract.targets,
    dependencies: contract.deps.map(
      (dependency) => FINAL_PACKAGES[dependency].npmName,
    ),
  }));
  return [
    ...products,
    ...TOOL_PROJECTS.map((project) => ({
      ...project,
      dependencies: project.dependencies.map(
        (dir) => FINAL_PACKAGES[dir].npmName,
      ),
    })),
  ];
}
