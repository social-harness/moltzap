/** @file Fixed wire identities shared by host parsing and boundary scenarios. */

import { testAgentView } from "./agent-card-fixtures.js";
import { collectiveOperationId } from "./collective-id-fixtures.js";

/** Host scenarios use Bob's requester namespace. */
export const requestId = collectiveOperationId(
  testAgentView("agent:bob").agentId,
);
