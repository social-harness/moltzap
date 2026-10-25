/**
 * @file Package ESLint configuration: the shared workspace preset plus the
 * rules that keep envelope signing in its owning modules.
 */
import { packageEslintConfig } from "../../eslint.shared.js";

/** Test files, which sign peer envelopes directly. */
const testFiles = ["src/**/*.test.ts", "src/**/__tests__/**"];

/**
 * Keeps `communication/conversations/outbox.ts` the one production module that signs
 * an outer envelope, which it stores before the Router worker sends it.
 * `communication/records/` defines and re-exports the signers.
 */
const soleOuterSigner = {
  files: ["src/**/*.ts"],
  ignores: [
    "src/communication/conversations/outbox.ts",
    "src/communication/records/**",
    ...testFiles,
  ],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex: "(^|/)records/(encoding/)?(index|codec)\\.js$",
            importNames: ["signOuterPacket", "signOuterEvidence"],
            message:
              "Only communication/conversations/outbox.ts signs outer envelopes; queue the body through the engine outbox.",
          },
        ],
      },
    ],
  },
};

/**
 * Keeps `communication/records/encoding/codec.ts` the one module that calls
 * Identity's `SignedMessage.sign`, which it does for an outer envelope only
 * after sealing its body. The guard covers who signs, not what the outbox
 * enqueues: its port accepts any `SignedMessage`.
 */
const sealingSigner = {
  files: ["src/**/*.ts"],
  ignores: ["src/communication/records/encoding/codec.ts", ...testFiles],
  rules: {
    "no-restricted-properties": [
      "error",
      {
        object: "SignedMessage",
        property: "sign",
        message:
          "Only communication/records/encoding/codec.ts signs a SignedMessage, after sealing every outer body; queue the body through the engine outbox.",
      },
    ],
  },
};

export default [
  ...packageEslintConfig({
    projects: ["./tsconfig.json", "./tsconfig.test.json"],
    tsconfigRootDir: import.meta.dirname,
  }),
  soleOuterSigner,
  sealingSigner,
];
