# Contributing

Thanks for helping improve the TradeSmart SDK for JavaScript and TypeScript. The SDK lives in
`sdk-javascript/`; its contributing guide has the setup, test and style instructions:
[sdk-javascript/CONTRIBUTING.md](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/CONTRIBUTING.md).
Everything runs in Docker.

Language-neutral material lives at the root: documentation in
[`docs/`](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/docs/README.md) and the
behaviour contract, conformance vectors and test fixtures in
[`specifications/`](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/tree/main/specifications).
SDKs for other languages use the same contract, so keep it free of language-specific code.

## Pull requests

- Keep changes focused and explain the reason for them.
- Add or update tests, and update the docs and the relevant CHANGELOG.
- Make sure the CI checks pass.
- No Developer Certificate of Origin sign-off is required.
- Be kind: see the [code of conduct](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/CODE_OF_CONDUCT.md).

## Never commit credentials

Do not commit tokens, secret keys, app keys, checksums, auth codes, or `.env` files. Tests and fixtures
must use synthetic values only. Report security issues privately as described in
[SECURITY.md](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/SECURITY.md).
