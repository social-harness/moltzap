// SPIKE: a burst of concurrent replies in one negotiated group conversation.
// Starts five sharnessd processes against the Registry and Router in
// SPIKE_NETWORK (a directory with .env and admission-credential, as the
// local-network guide writes), drives scripted agent sends over MCP with the
// owner role, and prints what each agent's inbox and each send returned.
// usage: SPIKE_NETWORK=<dir> SPIKE_GROUP_NORM=<BEHAVIOR.md> SPIKE_OFFICE_NORM=<BEHAVIOR.md> node spike/e2e.mjs

import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const network = process.env.SPIKE_NETWORK;
const env = readFileSync(join(network, ".env"), "utf8");
const setting = (name) => env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
const signer = setting("SHARNESS_NETWORK_REGISTRY_SIGNER").replace(
  /^'|'$/g,
  "",
);
const groupNorm = readFileSync(process.env.SPIKE_GROUP_NORM, "utf8");
const officeNorm = readFileSync(process.env.SPIKE_OFFICE_NORM, "utf8");
const root = join(network, "agents");
rmSync(root, { recursive: true, force: true });
const daemon = new URL("../bin/sharnessd", import.meta.url).pathname;
const id = (prefix) => `${prefix}_${randomBytes(16).toString("base64url")}`;

const agents = {
  "alvarez-agent": {
    port: 4101,
    norms: { hold: [groupNorm], adopt: true, waitSeconds: 20 },
  },
  "sarah-agent": { port: 4102, norms: { hold: [], adopt: true } },
  "john-agent": { port: 4103, norms: { hold: [], adopt: true } },
  "prof-agent": { port: 4104, norms: { hold: [], adopt: true } },
  "student-agent": { port: 4105, norms: { hold: [], adopt: true } },
};

const processes = [];
for (const [name, agent] of Object.entries(agents)) {
  const dir = join(root, name);
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(
    join(dir, "key.pem"),
    generateKeyPairSync("ed25519").privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
  );
  writeFileSync(
    join(dir, "admission"),
    readFileSync(join(network, "admission-credential")),
  );
  agent.owner = randomBytes(32).toString("base64url");
  writeFileSync(join(dir, "owner"), agent.owner);
  writeFileSync(join(dir, "runtime"), randomBytes(32).toString("base64url"));
  const log = openSync(join(dir, "daemon.log"), "w");
  processes.push(
    spawn(process.execPath, [daemon], {
      stdio: ["ignore", log, log],
      env: {
        PATH: process.env.PATH,
        SHARNESS_MCP_PORT: String(agent.port),
        SHARNESS_STATE_DIRECTORY: join(dir, "state"),
        SHARNESS_REGISTRY_ORIGIN: `http://127.0.0.1:${setting("SHARNESS_NETWORK_REGISTRY_PORT")}`,
        SHARNESS_REGISTRY_SIGNER_PUBLIC_KEY: signer,
        SHARNESS_ROUTER_ORIGIN: `http://127.0.0.1:${setting("SHARNESS_NETWORK_ROUTER_PORT")}`,
        SHARNESS_AGENT_PRIVATE_KEY_FILE: join(dir, "key.pem"),
        SHARNESS_ADMISSION_CREDENTIAL_FILE: join(dir, "admission"),
        SHARNESS_MCP_OWNER_CREDENTIAL_FILE: join(dir, "owner"),
        SHARNESS_MCP_RUNTIME_CREDENTIAL_FILE: join(dir, "runtime"),
        SHARNESS_REGISTRATION_AGENT_NAME: name,
        SHARNESS_REGISTRATION_OPERATION_ID: id("opn"),
        SHARNESS_REGISTRATION_PRINCIPAL_ID: id("prn"),
        SHARNESS_EXPERIMENT_HIDE_COLLECTIVES: "true",
        SHARNESS_EXPERIMENT_NORMS: JSON.stringify(agent.norms),
      },
    }),
  );
}
process.on("exit", () => processes.forEach((p) => p.kill()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(name) {
  const agent = agents[name];
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const client = new Client({ name: "spike-driver", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${agent.port}/mcp`),
          {
            requestInit: {
              headers: { Authorization: `Bearer ${agent.owner}` },
            },
          },
        ),
      );
      const status = await client.callTool({ name: "status", arguments: {} });
      if (JSON.stringify(status).includes("active")) {
        return client;
      }
      await client.close();
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`${name} did not become active`);
}

const clients = {};
for (const name of Object.keys(agents)) {
  clients[name] = await connect(name);
  console.log(`${name}: active`);
}

async function send(from, to, text) {
  let body = "sent";
  try {
    const result = await clients[from].callTool(
      { name: "send_message", arguments: { input: { to, text } } },
      undefined,
      { timeout: 120_000 },
    );
    if (result.isError) {
      body = `REFUSED ${result.content?.[0]?.text}`;
    }
  } catch (error) {
    body = `REFUSED ${error.message}`;
  }
  console.log(`\n>>> ${from} → ${to}\n${text}\n<<< ${body}`);
  return body === "sent";
}

async function inbox(name) {
  const seen = [];
  let cursor;
  for (;;) {
    const result = await clients[name].callTool({
      name: "read_inbox",
      arguments: cursor === undefined ? {} : { cursor },
    });
    const page = result.structuredContent ?? {};
    for (const item of page.items ?? []) {
      const data = item.data ?? item;
      const message = (data.item ?? data).message ?? {};
      const text = (message.content ?? [])
        .map((part) => part.text ?? JSON.stringify(part))
        .join("\n");
      seen.push({ from: message.sender, text, guidance: data.guidance });
    }
    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  console.log(`\n=== ${name}'s inbox: ${seen.length} item(s)`);
  for (const entry of seen) {
    console.log(`--- from ${JSON.stringify(entry.from)}\n${entry.text}`);
    if (entry.guidance) {
      const instructions = (entry.guidance.instructions ?? [])
        .map((i) => i.instruction)
        .join("\n");
      console.log(
        `    [guidance to the agent] ${instructions.slice(0, 900)}${instructions.length > 900 ? "…" : ""}`,
      );
    }
  }
  return seen;
}

async function norms(name) {
  const result = await clients[name].callTool({
    name: "read_norms",
    arguments: {},
  });
  const page = result.structuredContent ?? {};
  console.log(`\n=== ${name}'s read_norms: ${JSON.stringify(page.tasks)}`);
  for (const norm of page.norms ?? []) {
    console.log(
      `--- norm ${norm.name} (${norm.text.length} chars): ${norm.description}`,
    );
  }
}

const everyone = Object.keys(agents);
const group = `group:${[...everyone].sort().join(",")}`;
const members = everyone.filter((name) => name !== "alvarez-agent");
await send(
  "alvarez-agent",
  group,
  `(call-meeting\n  :meeting m1\n  :members [${members.map((name) => `agent:${name}`).join(" | ")}]\n  :length 30 minutes\n  :candidates [1 Mon 10:00–10:30 | 2 Tue 11:00–11:30 | 3 Wed 13:00–13:30])`,
);
await sleep(4000);
console.log("\n######## burst: every member answers at once");
await Promise.all(
  members.map((name) =>
    send(name, group, "(availability\n  :meeting m1\n  :free [1 | 3])"),
  ),
);
await sleep(8000);
console.log(
  "\n######## an agent's act named like a negotiation act is checked under the norm",
);
await send("alvarez-agent", group, "(propose\n  :meeting m1\n  :slot 3)");
for (const name of everyone) {
  const seen = await inbox(name);
  console.log(
    `>>> ${name} saw ${seen.filter((entry) => entry.text?.startsWith("(availability")).length} availability`,
  );
  const decisions = await clients[name].callTool({
    name: "firewall_decisions",
    arguments: {},
  });
  for (const row of decisions.structuredContent?.checks ??
    decisions.structuredContent?.decisions ??
    []) {
    console.log(`    decision ${JSON.stringify(row).slice(0, 400)}`);
  }
}
process.exit(0);
