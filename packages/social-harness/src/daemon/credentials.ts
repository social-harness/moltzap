/** @file Fail-closed loading of the agent key and secret credential files. */

import { Data, Effect, Redacted, Schema } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Bootstrap reads configured credential files before the daemon composes its platform services.
import { readFile } from "node:fs/promises";
import { AgentSigningAuthority } from "../identity/keys.js";

/**
 * One non-diagnostic credential loading failure. Its stage says whether
 * reading the file as exact UTF-8 failed or the text it holds was refused, so
 * callers map it onto their own closed reasons without ever seeing
 * the path, the bytes, or the decoder detail.
 */
export class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly stage: "file" | "value";
}> {}

/**
 * Grammar of an admission credential: 8 to 512 token characters with optional
 * base64 padding, exactly as the file holds it with no surrounding whitespace.
 * Other bearer credentials narrow it.
 */
export const credentialText = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(512),
  Schema.pattern(/^[A-Za-z0-9\-._~+/]+=*$/u),
);

const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

const fileFailure = (): CredentialError =>
  new CredentialError({ stage: "file" });
const valueFailure = (): CredentialError =>
  new CredentialError({ stage: "value" });

const readExactUtf8 = (
  path: Redacted.Redacted,
): Effect.Effect<string, CredentialError> =>
  Effect.tryPromise({
    try: () => readFile(Redacted.value(path)),
    catch: fileFailure,
  }).pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        try: () => utf8Decoder.decode(bytes),
        catch: fileFailure,
      }),
    ),
  );

/**
 * Reads one secret file and accepts its exact text.
 *
 * @param path Redacted location of the credential file.
 * @param grammar Grammar the whole file text must satisfy.
 * @returns The redacted credential.
 */
export const readCredential = (
  path: Redacted.Redacted,
  grammar: Schema.Schema<string>,
): Effect.Effect<Redacted.Redacted, CredentialError> =>
  readExactUtf8(path).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknown(grammar)(text).pipe(Effect.mapError(valueFailure)),
    ),
    Effect.map(Redacted.make),
  );

/**
 * Reads the agent's PKCS#8 private key and constructs its Ed25519 authority.
 *
 * @param path Redacted location of the private key file.
 * @returns Opaque signing authority for the configured agent.
 */
export const loadSigningAuthority = (
  path: Redacted.Redacted,
): Effect.Effect<AgentSigningAuthority, CredentialError> =>
  readExactUtf8(path).pipe(
    Effect.flatMap((privateKey) =>
      AgentSigningAuthority.fromPkcs8(Redacted.make(privateKey)).pipe(
        Effect.mapError(valueFailure),
      ),
    ),
  );

/**
 * Reads the admission credential an unregistered agent presents.
 *
 * @param path Redacted location of the admission credential file.
 * @returns The redacted admission credential.
 */
export const loadAdmissionCredential = (
  path: Redacted.Redacted,
): Effect.Effect<Redacted.Redacted, CredentialError> =>
  readCredential(path, credentialText);
