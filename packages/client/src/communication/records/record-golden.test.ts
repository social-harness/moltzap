/**
 * @file Fixed GENESIS and POST records keep canonical bytes and hashes and verify
 * under their synthetic retained wire policy, independently of the live reset.
 * Reproduce with node scripts/generate-client-record-golden.ts after pnpm build.
 */

import { live as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  decodeCanonical,
  encodeCanonical,
} from "../../encoding/canonical-json.js";
import { Ed25519PublicKey } from "../../identity/keys.js";
import { WireVersions } from "../../identity/wire-version.js";
import {
  ActionCertifiedRecord,
  CertifiedRecord,
  DirectPacket,
  hashAction,
  hashRecord,
  MembershipDescriptor,
  verifyActionCertifiedRecord,
  verifyCertifiedRecord,
  verifyMembershipDescriptor,
} from "./index.js";
import golden from "./record-golden.json" with { type: "json" };

const utf8 = new TextEncoder();

/** Each fixture holds the Registry key and membership needed to verify it offline. */
function membershipOf(form: (typeof golden.forms)[number]) {
  return Effect.gen(function* () {
    const key = yield* Schema.decodeUnknown(Ed25519PublicKey)(
      form.registrySignerPublicKey,
    );
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)(
      form.membership,
    );
    return yield* verifyMembershipDescriptor(descriptor, key);
  });
}

describe("canonical record golden bytes", () => {
  it.each(
    golden.forms.filter((form) => form.kind === "action_certified_record"),
  )("preserves $name", (form) =>
    Effect.gen(function* () {
      const bytes = utf8.encode(form.bytes);
      const record = yield* decodeCanonical(ActionCertifiedRecord, bytes);
      expect(yield* encodeCanonical(DirectPacket, record)).toEqual(bytes);
      expect(yield* hashRecord(record.recordCore)).toBe(form.recordHash);
      expect(yield* hashAction(record.recordCore.action)).toBe(form.actionHash);
      yield* verifyActionCertifiedRecord({
        record,
        membership: yield* membershipOf(form),
      });
    }).pipe(
      Effect.provideService(WireVersions, {
        live: [],
        history: [form.membership.sharnessVersion],
      }),
    ),
  );
  it.each(golden.forms.filter((form) => form.kind === "certified_record"))(
    "preserves $name",
    (form) =>
      Effect.gen(function* () {
        const bytes = utf8.encode(form.bytes);
        const record = yield* decodeCanonical(CertifiedRecord, bytes);
        expect(yield* encodeCanonical(DirectPacket, record)).toEqual(bytes);
        expect(yield* hashRecord(record.actionCertifiedRecord.recordCore)).toBe(
          form.recordHash,
        );
        expect(
          yield* hashAction(record.actionCertifiedRecord.recordCore.action),
        ).toBe(form.actionHash);
        yield* verifyCertifiedRecord({
          record,
          membership: yield* membershipOf(form),
        });
      }).pipe(
        Effect.provideService(WireVersions, {
          live: [],
          history: [form.membership.sharnessVersion],
        }),
      ),
  );
});
