/** @file Retired configuration diagnostics disclose names without secret values. */

import { expect, it } from "vitest";
import { legacyKeys } from "../index.js";

it("finds both retired prefixes, including empty values, without returning values", () => {
  expect(
    legacyKeys({
      MOLTZAPD_STATE_DIRECTORY: "/private/path",
      MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL: "secret",
      MOLTZAP_EMPTY: "",
      SHARNESS_STATE_DIRECTORY: "/current",
      OTHER_MOLTZAP_KEY: "kept",
    }),
  ).toEqual([
    "MOLTZAP_EMPTY",
    "MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL",
    "MOLTZAPD_STATE_DIRECTORY",
  ]);
});
