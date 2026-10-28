/** @file Host-relative NanoClaw channel registry signature. */

import type { ChannelRegistration } from "./adapter.js";

// safer-arch-ignore no-trivial-sink-file: The image installs the channel source beside NanoClaw's real registry module; this local sink only lets the private package compile in isolation.

/** Registry sink replaced by NanoClaw's host implementation in the agent image. */
export const registerChannelAdapter: (
  name: string,
  registration: ChannelRegistration,
) => void = () => {};
