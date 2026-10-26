/** @file Channel configuration writes remain restartable after an abandoned temporary write. */

import assert from "node:assert/strict";
import filesystem, {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("abandoned channel writes do not block installing the image channel", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "social-harness-channel-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "openclaw.json");
  const stale = `${path}.channel-${String(process.pid)}`;
  const abandoned = join(root, ".social-harness-channel-abandoned");
  await writeFile(stale, "unfinished configuration");
  await mkdir(abandoned);
  await writeFile(join(abandoned, "openclaw.json"), "unfinished configuration");
  await writeFile(
    path,
    JSON.stringify({
      plugins: {
        load: {
          paths: [],
        },
      },
    }),
  );
  const environment = { ...process.env };
  context.after(() => {
    process.env = environment;
  });
  process.env.OPENCLAW_CONFIG_PATH = path;

  await import("./configure-channel.ts");

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    plugins: {
      load: {
        paths: [
          "/opt/social-harness/launcher/current/node_modules/@moltzap/openclaw-channel",
        ],
      },
    },
  });
  assert.deepEqual(
    (await readdir(root)).sort((left, right) => left.localeCompare(right)),
    [
      ".social-harness-channel-abandoned",
      "openclaw.json",
      `openclaw.json.channel-${String(process.pid)}`,
    ],
  );
  assert.equal(await readFile(stale, "utf8"), "unfinished configuration");
});

test("a failed configuration rename keeps the old configuration and removes temporary files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "social-harness-channel-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "openclaw.json");
  const original = JSON.stringify({
    plugins: {
      load: { paths: [] },
    },
  });
  await writeFile(path, original);
  const environment = { ...process.env };
  const exitCode = process.exitCode;
  context.after(() => {
    process.env = environment;
    process.exitCode = exitCode;
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
  process.env.OPENCLAW_CONFIG_PATH = path;
  context.mock.method(filesystem, "rename", () =>
    Promise.reject(new Error("injected configuration rename failure")),
  );
  context.mock.method(console, "error", () => undefined);
  syncBuiltinESMExports();
  const script = new URL(
    "./configure-channel.ts?rename-failure",
    import.meta.url,
  );

  await import(script.href);

  assert.equal(process.exitCode, 1);
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await readdir(root), ["openclaw.json"]);
});

test("initializes channel loading in a stock host configuration", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "social-harness-stock-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "openclaw.json");
  await writeFile(
    path,
    JSON.stringify({ channels: { sharness: { enabled: true } } }),
  );
  const environment = { ...process.env };
  context.after(() => {
    process.env = environment;
  });
  process.env.OPENCLAW_CONFIG_PATH = path;
  await import(
    new URL("./configure-channel.ts?stock-config", import.meta.url).href
  );
  assert.partialDeepStrictEqual(JSON.parse(await readFile(path, "utf8")), {
    plugins: {
      load: {
        paths: [
          "/opt/social-harness/launcher/current/node_modules/@moltzap/openclaw-channel",
        ],
      },
    },
  });
});
