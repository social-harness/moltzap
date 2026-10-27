# Messaging recovery

This directory owns local catch-up and Router-restart recovery. It holds each
conversation's protocol traffic until that conversation's recovered position is
safe to use.

Start with `index.ts`. It owns the recovery run: its lifecycle, ingress
dispatch, the catch-up retries it schedules for each conversation, and the
ports its catch-up and re-anchor use. Each conversation recovers on its own,
and the run's traffic, including answers to members' catch-up requests, goes
out through the durable outbox. `catch-up.ts` asks members for history after a
position and answers their requests, sending a staged successor it holds in
place of `incomplete`. `successor.ts` takes members' staged, uncertified
successors of a recovering conversation's head and their durability votes:
recovery certifies such a successor at `q(n)` votes, and converts to one this
endpoint did not stage on the record alone after a feed gap, or on the record
and more than `n − q(n)` members' votes during a re-anchor. `barrier.ts` holds
the fences sends wait behind: one for the engine until a run has fenced each
conversation, then one per conversation until it recovers. Re-anchor lives in
`../reanchor/` and reaches the run only through its `ReanchorRunPort`. Stored
rows are verified in `../history/`, and `../startup.ts` rebuilds the engine's
state from the store when the engine starts.
