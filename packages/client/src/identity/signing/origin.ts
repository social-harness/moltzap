/** @file Platform-independent origin input for network client acquisition. */

/** Network clients consume an origin's serialized locator without platform URL methods. */
export interface HttpOrigin {
  readonly href: string;
}
