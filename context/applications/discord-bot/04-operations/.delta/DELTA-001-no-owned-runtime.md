# DELTA-001 - Cloudflare Production Admission Is Incomplete

Status: open

## Divergence

Cloudflare staging now supplies the canonical Worker and singleton Durable
Object realization, but exact-release functional and production-operational
admission evidence is incomplete.

## VRS

[Decision 0007](../.decisions/0007-use-cloudflare-canonical-host.md) selects the
canonical host. Requirements R07-R09, R12-R14, and R18-R19 define functional
proof, operational proof, deployment receipts, rollback, and production gates.

## Implementation

Source, an Alchemy stack, and a reachable staging runtime exist. The historical
Discord application remains reserved and cannot satisfy the fresh
environment-identity contract.

The functional gate has `0/11` canonical live-matrix lanes at PASS. This is a
functional verdict only; local or credential-free receipts do not change it.
It waits on a rotated E2E Actor token (DELTA-004).

Launch-operational evidence on staging (2026-09-27): authoritative remote
state (`verify-remote-authoritative` PASS), release identity reported by
`/readyz`, gateway-aware readiness, config reload recovery (DELTA-003
resolved), and binary known-good redeploy via `cf:rollback` (N → N-1 → N,
`applied`, `/readyz` 200 on each selected version). The 2-hour staging soak of
the release candidate is UNRUN. The earlier "runner admission" blocker was the
`ci` workflow, not a deploy workflow; runner admission is healthy. A
CI-owned deploy workflow exists and is a post-launch obligation under the
amended OPS-R19, as is 24 h/72 h reconnect observation.

## Direction

update implementation

## Resolution Signal

Provision and inventory fresh disjoint staging and production applications,
retain the runtime, historical bot, and E2E Actor memberships through the full
matrix, capture both verdicts from
[decision 0008](../.decisions/0008-separate-rollout-evidence.md), then uninstall
only the historical staging-guild membership and retain the E2E Actor. Enable
production only after both verdicts pass, and capture passive production
identity, readiness, deployment, rollback, diagnostic-policy, and sanitized
receipt evidence satisfying the operations requirements.
