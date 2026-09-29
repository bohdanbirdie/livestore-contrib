# DELTA-003 - Runtime Config Reload Stalls the Gateway Supervisor

Status: resolved

## Divergence

A runtime config reload (`PUT /admin/config` with `reload: true`) persists and
activates the new revision, but the Gateway supervisor it starts never reaches
READY or RESUMED. Staging stays not-ready until the next deploy restarts the
Durable Object. A deploy always boots the supervisor to ready.

## VRS

The operations requirements expect config changes to converge without a
deploy: revisioned compare-and-swap config with reload, and gateway-aware
readiness (see [decision 0008](../.decisions/0008-separate-rollout-evidence.md)
for the evidence split). Reload convergence is part of the operational
admission evidence.

## Implementation

Root-cause chain:

1. `forkDetach` inherited the closing call scope, so a gateway owner could
   outlive the request only in appearance. The owner now runs in the Durable
   Object instance context.
2. Effect 4's `MixedScheduler` flushes with `setTimeout(0)`; fiber work queued
   in an ended Worker invocation could remain stranded. The instance-owned
   fiber runner uses a microtask-backed scheduler.
3. Reload installed a runtime built in the admin RPC rather than following
   cold boot. Reload now validates before CAS, retires the old owner and
   schedules an alarm; alarm invocations alone build and start owners, and
   cron only re-arms a missing alarm. A 35-second gate-owner deadline covers
   a stall before the supervisor's attempt begins.
4. After DFX rejected a RESUME and reconnected (close code 3000), a new READY
   reset the session sequence. The supervisor compared it against the old
   session, discarded the READY, but still signalled establishment. The
   monotonic guard now compares sequences only within the same session ID,
   and establishment is signalled only when readiness is published.

Staging release `52a9af4` (Worker version `2e70b227`) passed two consecutive
same-config reloads on 2026-09-27: revisions 11 and 12 returned `/readyz` 200
with all checks true in 2.8 s and 1.8 s, respectively, with the supervisor
`ready`.

Follow-up: lifetime telemetry currently counts a re-IDENTIFY after a rejected
RESUME as `resumes`; distinguish the actual handshake outcome from the initial
attempt mode.

## Direction

update implementation

## Resolution Signal

A same-config reload on staging returns `/readyz` to 200 with all checks true
within the establishment deadline, twice in a row, with the `[bot-state]` tail
showing the post-reload supervisor reaching READY or RESUMED.
