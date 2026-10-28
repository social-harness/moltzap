/** @file Release notes retain their prose and identify every shipped image through the public writer. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseBody } from "./release-body.ts";

// @agent-code-guard/regression-only: Release creation, partial publication and reruns preserve prose and expose the verified images through the public writer.

const REGISTRY = `ghcr.io/social-harness/registry@sha256:${"a".repeat(64)}`;
const ROUTER = `ghcr.io/social-harness/router@sha256:${"b".repeat(64)}`;
const DAEMON = `ghcr.io/social-harness/daemon@sha256:${"c".repeat(64)}`;
const OPENCLAW = `ghcr.io/social-harness/openclaw-agent@sha256:${"d".repeat(64)}`;
const REFS = [REGISTRY, ROUTER, DAEMON, OPENCLAW];
const IMAGES = `### Images\n\n- \`${REGISTRY}\`\n- \`${ROUTER}\`\n- \`${DAEMON}\`\n- \`${OPENCLAW}\`\n`;

await test("a new release lists all four digest references after its changelog", () => {
  assert.equal(
    releaseBody("### Changed\n\nRelease prose.\n", REFS),
    `### Changed\n\nRelease prose.\n\n${IMAGES}`,
  );
});

await test("a partial release keeps existing entries and adds missing agent images", () => {
  const notes = `Release prose.\n\n### Images\n\n- \`${REGISTRY}\`\n- \`${ROUTER}\`\n`;
  assert.equal(
    releaseBody(notes, REFS),
    `${notes.trimEnd()}\n\n- \`${DAEMON}\`\n- \`${OPENCLAW}\`\n`,
  );
});

await test("rerunning a completed release preserves its body exactly", () => {
  const notes = `Release prose.\n\n${IMAGES}`;
  assert.equal(releaseBody(notes, REFS), notes);
});

await test("image references in prose still get an entry in the Images section", () => {
  assert.equal(
    releaseBody(`Uses ${DAEMON}.\n`, REFS),
    `Uses ${DAEMON}.\n\n${IMAGES}`,
  );
});

await test("missing images are inserted before the following section", () => {
  const notes = "Release prose.\n\n### Images\n\n### Links\n\nKeep these.\n";
  assert.equal(
    releaseBody(notes, REFS),
    `Release prose.\n\n${IMAGES}\n### Links\n\nKeep these.\n`,
  );
});
