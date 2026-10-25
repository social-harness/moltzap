/** @file Workspace acceptance tests for generated MODULE and MDX surfaces. */

import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Synchronous filesystem operations create and restore test fixtures outside the Effect under test.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ReflectionKind } from "typedoc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateModuleDocs,
  type ModuleRenderResult,
  REQUIRED_PACKAGE_SUBPATHS,
} from "../modules.ts";
import { folderOf, loadTypeDoc, type TypeDocCache } from "../typedoc-load.ts";

const GITHUB_SOURCE = "https://github.com/social-harness/moltzap/blob/main";

let sandbox = "";
let rendered: readonly ModuleRenderResult[] = [];
let identityModule = "";
let identityMdx = "";
let typeDocCache: TypeDocCache;

function writeFixture(relativePath: string, contents: string): void {
  const absolutePath = join(sandbox, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function source(
  fileName: string,
  line: number,
  url?: string,
): ReadonlyArray<{
  readonly fileName: string;
  readonly line: number;
  readonly character: number;
  readonly url?: string;
}> {
  return [
    {
      fileName,
      line,
      character: 0,
      ...(url === undefined ? {} : { url }),
    },
  ];
}

// eslint-disable-next-line agent-code-guard/async-keyword, max-lines-per-function, sonarjs/max-lines-per-function -- This fixture builds a complete TypeDoc workspace before Vitest awaits the Effect runner.
beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "module-docs-"));
  const cachePath = join(sandbox, "typedoc.json");
  const docsModulesDir = join(sandbox, "docs/modules");

  writeFixture(
    "packages/client/package.json",
    JSON.stringify({ name: "@moltzap/client" }),
  );
  writeFixture(
    "packages/client/src/identity/index.ts",
    "/**\n * @file Public identity values.\n * @module identity\n */\nexport interface AgentCard {}\n",
  );
  writeFixture(
    "packages/client/src/identity/private/index.ts",
    "/**\n * @file Private identity helpers.\n * @internal\n */\nexport const privateHelper = true;\n",
  );
  writeFixture(
    "packages/client/src/identity/registry.ts",
    'export class Registry {}\nexport type OperationId = string;\nexport const OperationId = "operation";\n',
  );
  writeFixture(
    "packages/registry/src/index.ts",
    '/** @file Private Registry process. */\nexport class StartupError extends Error {}\n/** Complete production Registry process composition. */\nexport const layer = "layer";\n',
  );
  writeFixture(
    "packages/client/src/identity/registry/client.ts",
    "export const privateClient = {};\n",
  );
  writeFixture(
    "packages/client/src/identity/registry/README.md",
    "# Registry\n",
  );
  writeFixture(
    "packages/client/src/identity/ignored.test.ts",
    "export const ignoredTest = true;\n",
  );
  writeFixture(
    "packages/client/src/identity/registry/__tests__/fixture.ts",
    "export const ignoredFixture = true;\n",
  );
  writeFixture(
    "packages/client/src/identity/registry/registry.types-check.ts",
    "export type IgnoredCanary = true;\n",
  );

  writeFixture(
    "packages/registry/package.json",
    JSON.stringify({ name: "@moltzap/registry" }),
  );
  writeFixture(
    "packages/router/package.json",
    JSON.stringify({ name: "@moltzap/router" }),
  );
  writeFixture(
    "packages/router/src/index.ts",
    "/** @file Public Router values. */\nexport class Router {}\n",
  );
  writeFixture(
    "packages/router/src/server.ts",
    'export { RouterServer } from "./router/server.js";\n',
  );
  writeFixture(
    "packages/router/src/router/server.ts",
    'export namespace RouterServer {\n  export const layer = "layer";\n}\n',
  );

  writeFixture(
    "packages/client/package.json",
    JSON.stringify({ name: "@moltzap/client" }),
  );
  writeFixture(
    "packages/client/src/index.ts",
    '/** @file Public client values. */\nexport interface HarnessEndpoint {}\nexport { AgentCard } from "./identity/index.js";\n',
  );
  writeFixture(
    "packages/client/src/service/index.ts",
    '/** @file Process composition. */\nexport namespace Daemon {\n  export const withFirewall = "layer";\n}\nexport const makeFirewall = "firewall";\n',
  );

  writeFixture("docs/modules/legacy/src.mdx", "stale page\n");
  writeFixture("packages/legacy/src/MODULE.md", "# stale module\n");

  writeFileSync(
    cachePath,
    JSON.stringify({
      children: [
        {
          name: "@moltzap/client",
          children: [
            {
              id: 100,
              name: "private",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 31,
                  name: "privateHelper",
                  kind: ReflectionKind.Variable,
                  sources: source(
                    "packages/client/src/identity/private/index.ts",
                    5,
                  ),
                },
              ],
            },
            {
              id: 101,
              name: "index",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 4,
                  name: "AgentCard",
                  kind: ReflectionKind.Interface,
                  sources: source("packages/client/src/identity/index.ts", 5),
                },
                {
                  id: 20,
                  name: "HarnessEndpoint",
                  kind: ReflectionKind.Interface,
                  sources: source("packages/client/src/index.ts", 2),
                },
              ],
            },
            {
              id: 102,
              name: "service",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 6,
                  name: "Registry",
                  kind: ReflectionKind.Class,
                  sources: source(
                    "packages/client/src/identity/registry.ts",
                    1,
                  ),
                },
                {
                  id: 7,
                  name: "OperationId",
                  kind: ReflectionKind.TypeAlias,
                  sources: source(
                    "packages/client/src/identity/registry.ts",
                    2,
                  ),
                },
                {
                  id: 8,
                  name: "OperationId",
                  kind: ReflectionKind.Variable,
                  sources: source(
                    "packages/client/src/identity/registry.ts",
                    3,
                  ),
                },
                {
                  id: 22,
                  name: "Daemon",
                  kind: ReflectionKind.Namespace,
                  sources: source("packages/client/src/service/index.ts", 2),
                  children: [
                    {
                      id: 23,
                      name: "withFirewall",
                      kind: ReflectionKind.Variable,
                      sources: source(
                        "packages/client/src/service/index.ts",
                        3,
                      ),
                    },
                  ],
                },
                {
                  id: 24,
                  name: "makeFirewall",
                  kind: ReflectionKind.Variable,
                  sources: source("packages/client/src/service/index.ts", 5),
                },
              ],
            },
            {
              id: 103,
              name: "registry/client",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 13,
                  name: "privateClient",
                  kind: ReflectionKind.Variable,
                  sources: source(
                    "packages/client/src/identity/registry/client.ts",
                    1,
                  ),
                },
              ],
            },
          ],
        },
        {
          name: "@moltzap/registry",
          children: [
            {
              id: 100,
              name: "index",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 10,
                  name: "StartupError",
                  kind: ReflectionKind.Class,
                  sources: source(
                    "C:\\workspace\\moltzap\\packages\\registry\\src\\index.ts",
                    1,
                  ),
                },
                {
                  id: 11,
                  name: "layer",
                  kind: ReflectionKind.Variable,
                  sources: source("packages/registry/src/index.ts", 3),
                  comment: {
                    summary: [
                      {
                        kind: "text",
                        text: "Complete production Registry process composition.",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        {
          name: "@moltzap/router",
          children: [
            {
              id: 100,
              name: "index",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 15,
                  name: "Router",
                  kind: ReflectionKind.Class,
                  sources: source("packages/router/src/index.ts", 2),
                },
              ],
            },
            {
              id: 101,
              name: "server",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 17,
                  name: "RouterServer",
                  kind: ReflectionKind.Namespace,
                  sources: source("packages/router/src/router/server.ts", 1),
                  children: [
                    {
                      id: 18,
                      name: "layer",
                      kind: ReflectionKind.Variable,
                      sources: source(
                        "packages/router/src/router/server.ts",
                        2,
                      ),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );

  typeDocCache = await Effect.runPromise(
    loadTypeDoc(cachePath, {
      packageSubpaths: REQUIRED_PACKAGE_SUBPATHS,
    }).pipe(Effect.provide(NodeContext.layer)),
  );
  rendered = await Effect.runPromise(
    generateModuleDocs(typeDocCache, {
      workspaceRoot: sandbox,
      docsModulesDir,
    }).pipe(Effect.provide(NodeContext.layer)),
  );
  identityModule = readFileSync(
    join(sandbox, "packages/client/src/identity/MODULE.md"),
    "utf8",
  );
  identityMdx = readFileSync(
    join(docsModulesDir, "client/identity.mdx"),
    "utf8",
  );
});

afterAll(() => {
  if (sandbox !== "") {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// @agent-code-guard/regression-only: fixed navigation and TypeDoc fixtures exercise distinct formatting and failure regressions.
// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The declarative suite keeps the related generated-document regression cases together.
describe("module documentation", () => {
  it("omits folders with a leading JSDoc @internal tag line", () => {
    const folder = "packages/client/src/identity/private";
    expect(rendered.map((result) => result.folder)).not.toContain(folder);
    expect(existsSync(join(sandbox, folder, "MODULE.md"))).toBe(false);
    expect(
      existsSync(join(sandbox, "docs/modules/client/identity/private.mdx")),
    ).toBe(false);
  });
  // eslint-disable-next-line agent-code-guard/async-keyword -- Vitest awaits this Promise boundary; the implementation under test remains an Effect.
  it("normalizes declaration roots reported from a worktree", async () => {
    const cachePath = join(sandbox, "typedoc-dist-path.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        children: [
          {
            name: "@moltzap/client",
            children: [
              {
                id: 100,
                name: "service",
                kind: ReflectionKind.Module,
                children: [
                  {
                    id: 102,
                    name: "Registry",
                    kind: ReflectionKind.Class,
                    sources: source(
                      "/workspace/moltzap-worktree/packages/client/dist/registry.d.ts",
                      1,
                    ),
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const cache = await Effect.runPromise(
      loadTypeDoc(cachePath, {
        packageSubpaths: ["@moltzap/client/service"],
      }).pipe(Effect.provide(NodeContext.layer)),
    );
    const [declaration] = cache.all;

    expect(declaration?.sources[0]?.fileName).toBe(
      // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
      "packages/client/dist/registry.d.ts",
    );
    expect(declaration === undefined ? "" : folderOf(declaration)).toBe(
      // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
      "packages/client/dist",
    );
  });

  it("renders Registry APIs only under their public package subpaths", () => {
    const libraryModule = readFileSync(
      join(sandbox, "packages/client/src/MODULE.md"),
      "utf8",
    );
    const [publicSurface = ""] = libraryModule.split("## Package subpaths");
    const registrySection = libraryModule
      .split("### `@moltzap/client/service`\n")[1]
      ?.split("## Files\n")[0];
    const serverSection = readFileSync(
      join(sandbox, "packages/registry/src/MODULE.md"),
      "utf8",
    );

    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(publicSurface).not.toContain("### [`Registry`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(publicSurface).not.toContain("OperationId");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(publicSurface).toContain("### [`AgentCard`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(registrySection).toContain("#### [`Registry`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(registrySection).toContain("#### [`OperationId (type)`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(registrySection).toContain("#### [`OperationId (value)`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(serverSection).toContain("### [`StartupError`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(serverSection).toContain("### [`layer`]");
    expect(serverSection).toContain(
      // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
      "Complete production Registry process composition.",
    );
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).not.toContain("@moltzap/client/server");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).not.toContain("#### [`RegistryServer`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).not.toContain("RegistryServer.");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).not.toContain("privateClient");
  });

  it("lists only production identity files", () => {
    const filesSection = readFileSync(
      join(sandbox, "packages/client/src/MODULE.md"),
      "utf8",
    )
      .split("## Files\n")[1]
      ?.trim()
      .split("\n")
      .filter((line) => line.startsWith("- `identity/"))
      .map((line) => line.replace("- `identity/", "- `"))
      .join("\n");

    expect(filesSection).toBe(
      [
        "- `index.ts`",
        "- `private/index.ts`",
        "- `registry.ts`",
        "- `registry/client.ts`",
        "- `registry/README.md`",
      ].join("\n"),
    );
  });

  it("qualifies only namespace members in package subpaths", () => {
    const clientModule = readFileSync(
      join(sandbox, "packages/client/src/MODULE.md"),
      "utf8",
    );

    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(clientModule).toContain("#### [`Daemon.withFirewall`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(clientModule).toContain("#### [`makeFirewall`]");
  });

  it("uses final package paths and main-branch source links", () => {
    expect(rendered.map(({ folder, pageSlug }) => [folder, pageSlug])).toEqual([
      ["packages/client/src", "client/src"],
      ["packages/client/src/identity", "client/identity"],
      ["packages/client/src/service", "client/service"],
      ["packages/registry/src", "registry/src"],
      ["packages/router/src", "router/src"],
    ]);
    expect(
      readFileSync(join(sandbox, "packages/client/src/MODULE.md"), "utf8"),
      // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    ).toContain("### `@moltzap/client/service`");
    expect(identityModule).toMatch(
      /## Purpose\n\nPublic identity values\.\n\n/u,
    );
    expect(identityMdx).toMatch(/## Purpose\n\nPublic identity values\.\n\n/u);
    expect(identityModule).not.toMatch(/@module/u);
    expect(identityMdx).not.toMatch(/@module/u);
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).toContain("# client/identity\n");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).toContain("_`packages/client/src/identity`_");
    expect(existsSync(join(sandbox, "docs/modules/router/src.mdx"))).toBe(true);
    expect(
      readFileSync(join(sandbox, "docs/modules/registry/src.mdx"), "utf8"),
    ).toContain(`${GITHUB_SOURCE}/packages/registry/src/index.ts#L1`);
  });

  // eslint-disable-next-line agent-code-guard/async-keyword -- Vitest awaits this Promise boundary; the implementation under test remains an Effect.
  it("requires final TypeDoc package names and public subpaths", async () => {
    const missingPackageEntries = new Map(typeDocCache.byPackageEntrypoint);
    missingPackageEntries.delete("@moltzap/router");
    await expect(
      Effect.runPromise(
        generateModuleDocs(
          { ...typeDocCache, byPackageEntrypoint: missingPackageEntries },
          {
            workspaceRoot: sandbox,
            docsModulesDir: join(sandbox, "docs/modules"),
          },
        ).pipe(Effect.provide(NodeContext.layer)),
      ),
    ).rejects.toThrow(
      "Required TypeDoc packages were not loaded: @moltzap/router",
    );

    const missingSubpathEntries = new Map(typeDocCache.byPackageEntrypoint);
    missingSubpathEntries.delete("@moltzap/client/service");
    await expect(
      Effect.runPromise(
        generateModuleDocs(
          { ...typeDocCache, byPackageEntrypoint: missingSubpathEntries },
          {
            workspaceRoot: sandbox,
            docsModulesDir: join(sandbox, "docs/modules"),
          },
        ).pipe(Effect.provide(NodeContext.layer)),
      ),
    ).rejects.toThrow(
      "Required TypeDoc package subpaths were not loaded: @moltzap/client/service",
    );
  });

  it("prunes generated pages whose source folder is gone", () => {
    expect(existsSync(join(sandbox, "docs/modules/legacy/src.mdx"))).toBe(
      false,
    );
    expect(existsSync(join(sandbox, "packages/legacy/src/MODULE.md"))).toBe(
      false,
    );
  });
});
