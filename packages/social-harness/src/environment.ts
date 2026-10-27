/** @file One fail-closed rule for environment names retired by the reset. */

/**
 * Returns only retired key names so startup diagnostics cannot expose values.
 * @param env Environment whose own keys are inspected before configuration is loaded.
 * @returns Sorted legacy keys, including keys with empty values.
 */
export function legacyKeys(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith("MOLTZAP_") || key.startsWith("MOLTZAPD_"))
    .sort((left, right) => left.localeCompare(right));
}
