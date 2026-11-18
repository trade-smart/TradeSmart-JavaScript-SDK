# Contributing to the JavaScript and TypeScript SDK

Thanks for helping. The SDK lives in `sdk-javascript/`. It implements the behaviour contract in
`specifications/`, the same one the Python SDK (`sdk-python/`) follows, and passes the same
conformance vectors.

**Everything runs in Docker from `sdk-javascript/`.** Never install Node.js, packages or tools on
your computer for this project, and never create a `node_modules` folder in the mounted tree (it
lives in a named Docker volume).

```bash
docker compose build
docker compose run --rm dev npm ci            # once per volume, and after package.json changes
docker compose run --rm dev npm test          # unit, conformance and mocked integration tests (Node 26)
docker compose run --rm dev npm run test:cov  # with the coverage floor
docker compose run --rm dev npm run lint      # eslint and the prettier check
docker compose run --rm dev npm run format    # prettier --write
docker compose run --rm dev npm run typecheck # tsc --noEmit
docker compose run --rm dev npm run build     # emits dist/
docker compose run --rm dev npm run pack:check  # npm pack --dry-run, publint, attw
docker compose run --rm node22 npm ci && docker compose run --rm node22 npm test   # the Node 22 floor
docker compose run --rm node24 npm ci && docker compose run --rm node24 npm test
```

## Gates before a change is done

1. `npm run lint` and `npm run typecheck` pass.
2. `npm test` passes on `dev` (Node 26), `node22` and `node24`, and `npm run test:cov` meets the
   coverage floor in `vitest.config.ts` (raise it when coverage rises, never lower it).
3. `npm run build` and `npm run pack:check` pass.
4. If you changed `specifications/`, the Python suite passes too (`docker compose run --rm dev pytest`
   from `sdk-python/`).

The default test run allows no network except loopback and uses an empty temporary folder for the
saved login. Live suites are opt-in and read-only (`TRADESMART_LIVE_TESTS=1 docker compose run --rm dev npx vitest run tests/live`;
one worker, never in watch mode; observations go to the gitignored `.live-results/`); tests that place orders
need their own opt-ins and a designated test account, are never part of a default run, and must never
use a funded account.

## Rules

- **Only what the documentation specifies.** Never invent endpoints, fields or behaviour; the contract
  in `specifications/sdk-behaviour.md` is the source of truth.
- **Orders are never retried.** `PlaceOrder`, `PlaceMultiOrder`, `ModifyOrder`, `CancelOrder`,
  `ExitSNOOrder`, `GenAcsTok`, the GTT writes and the iceberg writes. An ambiguous outcome is
  `OrderStatusUnknownError`.
- **No float on the money path.** Prices, money and volumes are `Decimal`; no number is read through a
  float.
- **Never log or store secrets.** Tokens, secret keys, checksums and codes never appear in a log, an
  error or a fixture. Fixtures and tests use synthetic values only; no real account id anywhere.
- **Models are generated.** Edit `specifications/models.json` through the Python generator, then run
  `npm run gen:models`; a test fails when the generated code is stale.
- **Documentation is tested.** Every fenced `ts` block in `README.md` and `docs/` and every file in
  `examples/` must type-check (`tests/unit/docs.test.ts`); keep them complete and self-contained.
  Examples that place orders are marked for a test account and use a LIMIT price far from the market.
- No other broker's name in any file.
- The library never touches `console`; log through the `Logger` in the configuration.

## Pull requests

- Keep changes focused and explain the reason for them.
- Add or update tests, the docs and `CHANGELOG.md`.
- Be kind: see the [code of conduct](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/CODE_OF_CONDUCT.md).

Report security issues privately as described in
[SECURITY.md](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/SECURITY.md).
