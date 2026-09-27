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
back to IDENTIFY. Alarms and cron calls continued throughout. Subsequent
content-free `[gw-diag]` logs separated the socket and timer stall from an
interruption or finalizer hang.

A content-free staging tail on 2026-09-26 (release `a16b094`, Worker version
`917b4fdb`) isolated the failure: old-owner interruption and every attempt
finalizer completed within the reload RPC. The immediate alarm started a RESUME
attempt, constructed a WebSocket and published Connecting, but its invocation
returned before the socket opened. For the next three minutes, alarms ran every
five seconds while no WebSocket OPEN/HELLO, attempt heartbeat, or handshake
deadline fired. Unlike cold boot, the reload candidate had already been built
in the admin RPC and subsequent alarm journal maintenance was stale-only; cold
boot performs additional initialization and first-run recovery. Neither path
previously held the starting invocation through Gateway establishment.

An initial change held the starting alarm through READY/RESUMED or 30 seconds,
but staging release `bd7ed88` (Worker version `d0162428`) still stayed not-ready
after reload: across eight minutes, the same RESUME attempt remained
`connecting`, with no handshake deadline or watchdog action. The tail dropped
the initial RPC/alarm events, so it cannot prove which invocation first stalled.

Effect 4's default `MixedScheduler` uses `setTimeout(0)` to flush fiber work on
Workers (`effect/src/Scheduler.ts`); the instance runner had captured its
constructor-time scheduler. A pending flush associated with an ended request
context can strand later continuations, even if an alarm stays in flight while
awaiting that fiber. This is a source-backed explanation, pending live proof,
not an observation of Cloudflare's internal scheduler. The instance runner now
uses Effect's microtask-backed `MixedScheduler('sync')`, retaining its yield
budget without a stale macrotask dispatcher. The supervisor also registers an
attempt with its watchdog before the durable `AttemptStarted` append, and an
overdue alarm interrupts the exact owner, clears the session after interruption,
and records the normal handshake failure before the next alarm starts IDENTIFY.
The starting alarm still waits outside the lifecycle mutex for establishment.
This delta remains open until two same-config reloads restore `/readyz` within
the deadline.

## Direction

update implementation

## Resolution Signal

A same-config reload on staging returns `/readyz` to 200 with all checks true
within the establishment deadline, twice in a row, with the `[bot-state]` tail
showing the post-reload supervisor reaching READY or RESUMED.
