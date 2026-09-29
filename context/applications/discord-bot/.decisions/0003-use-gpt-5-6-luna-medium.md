# 0003 — Use GPT-5.6 Luna at medium reasoning effort

Status: accepted

## Context

Automatic thread naming and explicit documentation assistance need a shared AI
generation source with an intentional quality, latency, and cost posture. The
model does not own eligibility, authorization, canonical documentation truth,
or the decision to create a basic thread.

## Decision

Use the OpenAI Responses API with model ID `gpt-5.6-luna` and
`reasoning.effort: "medium"` for bot-owned AI generation. Each feature keeps a
strict output boundary: a title is a validated proposal, and a docs answer must
be grounded in the selected documentation snapshot. Timeouts, quotas, or model
failure degrade independently and never suppress otherwise eligible basic
thread creation.

Accepted 2026-08-23 by explicit maintainer direction. The official OpenAI model
catalog lists `gpt-5.6-luna`, Responses API support, and `medium` reasoning
effort.

## Amendment 1 (2026-09-27)

Bot-owned AI generation moves to `gpt-6-luna` at `reasoning.effort: "medium"`,
by explicit maintainer direction. OpenAI released GPT-6 Luna on 2026-09-22 as
the lowest-cost GPT-6 model: $0.10/1M input and $0.50/1M output tokens,
against $0.20/$1.20 for `gpt-5.6-luna`. It supports the Responses API,
structured outputs, and the same `medium` reasoning effort
([model page](https://developers.openai.com/api/docs/models/gpt-6-luna)). The
output boundaries and degradation rules above are unchanged. Requirement
`LSC.APP.DISCORD-R07` names the new model.
