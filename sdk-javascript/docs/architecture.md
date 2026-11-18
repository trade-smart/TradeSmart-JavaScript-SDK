# Architecture

How the TradeSmart SDK for JavaScript and TypeScript is built, for contributors and for readers who
want to know what happens between `placeOrder()` and the wire. The behaviour it implements is
specified, language-neutrally, in `specifications/sdk-behaviour.md`; the Python SDK in `sdk-python/` is
the reference implementation, and this SDK passes the same conformance vectors.

## Principles

1. **Safety first.** An order is never retried and an unclear outcome is reported, not guessed.
   Secrets never reach a log, an error or a model's `toString`.
2. **No float on the money path.** Prices, money and volumes are `Decimal`. JSON is parsed so that no
   number beyond 2^53 or with a fraction is ever read through a float: every number is kept as its
   exact source text until a field's type turns it into a `Decimal` or an integer.
3. **Only what the documentation specifies.** No invented endpoints, fields or behaviour; gaps are
   recorded, not papered over.
4. **One tested core.** Request building, response classification and parsing are pure functions
   with no I/O; the transport is the only part that touches the network.
5. **Four runtime dependencies:** `decimal.js`, `undici` (HTTP), `ws` (WebSocket) and `fflate` (unzip
   the script master).

## Layers

```
Your code
  TradeSmart            TradeSmartStream            (src/client.ts, src/stream/)
      |                       |
  endpoints/ (build a request, decode a response)     models/ (generated parsers)
      |
  lib/call.ts   rate limit -> encode -> send -> classify -> retry (reads only) -> decode
      |
  transport/    undici dispatcher, timeouts, no redirects, failure mapping
```

| Folder                                                        | Responsibility                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client.ts`                                               | `TradeSmart`: every REST method, built on one call path                                                                                                                      |
| `src/endpoints/`                                              | One file per area (`user`, `portfolio`, `orders`, `gtt`, `market`): the request payload and the decoder                                                                      |
| `src/models/`                                                 | Response models. `generated/` is produced from `specifications/models.json` and never edited by hand; a test fails when it is stale                                          |
| `src/lib/`                                                    | Not exported: the `jData` encoder, outcome classification, retry, rate limiter, order outcome log, slicing planner, redaction, logging, time, decimal and validation helpers |
| `src/transport/`                                              | undici: connection pool, timeouts, no redirects, mapping of undici failures to the contract's failure kinds                                                                  |
| `src/instruments/`                                            | The script master: download, freshness, unzip, parse, row cache                                                                                                              |
| `src/stream/`                                                 | `TradeSmartStream`: protocol, state machine, delivery, backlog                                                                                                               |
| `src/token-store/`                                            | The saved login shared with the Python SDK                                                                                                                                   |
| `src/config.ts`, `src/errors.ts`, `src/auth.ts`, `src/env.ts` | Settings, the error tree, the login helpers, `fromEnv`                                                                                                                       |

## Data flow of a REST call

1. A method (`placeOrder`) validates its parameters and builds a **call spec**: the endpoint, the
   ordered payload, whether it changes state, the rate-limit group and a decoder. A bad parameter
   throws here, before anything else happens.
2. The call path takes a rate-limit slot, encodes the payload as `jData=<json>` with a hand-written
   encoder (not `JSON.stringify`) so the bytes match the contract's vectors, and adds the bearer token.
3. The transport sends it and returns the status and the body, or a classified failure.
4. The body is parsed **whatever the HTTP status**; `stat` and `emsg` decide success. The classifier
   maps the outcome to a result or an error (`AuthenticationError`, `OrderRejectedError`, ...). A write
   whose outcome is ambiguous becomes `OrderStatusUnknownError`.
5. Only reads are retried, only after failures that provably changed nothing, with back-off.
6. The decoder turns the body into models; a failing field becomes `null` (leniency) unless it is one
   of the protected identity fields (`norenordno`, `status`, `al_id`), which fail the whole call.

## WebSocket architecture

`StreamConnection` owns the socket: connect, the login frame, heartbeats, reconnect with back-off and
re-subscription, and the per-instrument snapshots. It only parses and enqueues. A separate **dispatch
loop** (`stream/delivery.ts`) runs your callbacks one at a time in arrival order, awaiting a returned
Promise, and feeds the async iterator, so a slow callback never delays reading, heartbeats or
reconnects. When 1,000 messages wait, price and depth updates for one instrument are merged; order and
position updates never are.

## Safety design

- Never auto-retry `PlaceOrder`, `PlaceMultiOrder`, `ModifyOrder`, `CancelOrder`, `ExitSNOOrder`,
  `GenAcsTok`, the GTT writes or the iceberg writes. Success only on the documented `stat` word.
- Never follow an HTTP redirect (a redirect could re-send an order body).
- `AbortSignal` support: an abort before the request was handed over sends nothing; after, the outcome
  of a write is unknown.
- Redaction by key name and pattern in logs, error bodies and `raw`.
- The client prints only its client id; `Secret` values print as `***`.

## Testing architecture

- `tests/unit/`: one file per source module, plus the docs and public-surface checks.
- `tests/conformance/`: one test per file of `specifications/conformance/`, loading the shared vectors.
  Cases that cannot be expressed in the language are pinned in one list with their reason, and the
  suite fails when a listed case disappears or an unlisted one is skipped.
- `tests/integration/`: the real client against undici's `MockAgent` and a local `ws` server.
- `tests/live/`: opt-in, read-only, against the real service.
- The default run allows no network except loopback and keeps the saved login out of the test process.
- Every fenced `ts` block of the guide and every example is type-checked against the SDK's source.

## Other languages

`sdk-javascript/` and `sdk-python/` implement the same contract. A new language starts from
`specifications/new-language-sdk.md`.
