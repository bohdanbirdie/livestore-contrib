# DELTA-003 - Runtime Config Reload Stalls the Gateway Supervisor

Status: open

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

Observed on staging, 2026-09-26, releases `15642b3` through `2d383bb`:

- After a reload, `/readyz` returns 503 with `supervisorReady=false` and
  `gatewayHealthy=false`; journal, session and error checks stay true.
- Runtime status stays frozen: supervisor `resuming`, current attempt
  `connecting`, attempt 1, no `lastError`. Even a 30 s establishment deadline
  never fires.
- Every 5 s alarm tick logs `gateClaimed=false supervisor=resuming`: the gate
  is held by a supervisor fiber that exists but does not progress.

The old fiber is explicitly interrupted and awaited, and the gate released;
the alarm does start a replacement. Capturing the Durable Object instance's
Effect context rather than inheriting the alarm call context addressed one
lifetime defect, but was **not sufficient**: staging release `daaef3f`
(Worker version `54426a45`) accepted a same-config reload at 21:34Z and
stayed not-ready for about 28 minutes before RESUMED at 22:02Z. Three attempts
ran, none recorded a handshake timeout, and the persisted session never fell
back to IDENTIFY. Alarms and cron calls continued throughout. The stall may be
in the establishment timer or in interruption/cleanup after that timer wins;
neither is proven from existing telemetry. Temporary content-free `[gw-diag]`
logs bracket the timer, race, transport acquire, socket events, and finalizers
for the next staging-only diagnostic reload. This delta remains open.

## Direction

update implementation

## Resolution Signal

A same-config reload on staging returns `/readyz` to 200 with all checks true
within the establishment deadline, twice in a row, with the `[bot-state]` tail
showing the post-reload supervisor reaching READY or RESUMED.
