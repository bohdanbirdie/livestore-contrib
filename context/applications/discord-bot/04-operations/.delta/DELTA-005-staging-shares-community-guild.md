# DELTA-005 - Staging Shares the Community Guild

Status: open

## Divergence

Staging and its E2E Actor are installed in the community guild that production
will also use, not in a dedicated staging guild. Staging acts only in two
staging-only channels (`test-channel` and a private restricted channel), and
production must never list those channels.

## VRS

`LSC.APP.DISCORD.OPS-R15` requires staging to use a dedicated guild with no
production membership, and `OPS-R18` names a two-channel `bot-staging` area
(`#staging-e2e`, `#staging-docs-restricted`) (see
[decision 0003](../.decisions/0003-isolate-staging-discord-identity.md)).

## Implementation

The 2026-09-25/26 rollout hardened two channels of the community guild
instead: the restricted channel is private, and the historical bot's overwrite
was removed from `test-channel`. The staging config's `actionChannelIds` and
`stagingOnlyChannelIds` contain only those two channels. Guild isolation checks
(13/13) and actor permissions are verified read-only through the bot tokens.
The production launch set (decision q24, 2026-09-27) is six public channels
disjoint from both staging channels.

## Direction

update requirements

## Resolution Signal

Either OPS-R15/R18 are amended to allow staging-only channels inside the
community guild with the disjointness invariant enforced by the deployment
contract, or staging moves to a dedicated guild and the community guild
membership is removed.
