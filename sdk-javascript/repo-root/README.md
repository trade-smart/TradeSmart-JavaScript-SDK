<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/gh/trade-smart/TradeSmart-JavaScript-SDK@v2.0.0/sdk-javascript/docs/assets/tradesmart-logo-dark.svg">
    <img src="https://cdn.jsdelivr.net/gh/trade-smart/TradeSmart-JavaScript-SDK@v2.0.0/sdk-javascript/docs/assets/tradesmart-logo.svg" alt="TradeSmart" width="240">
  </picture>
</p>

# TradeSmart SDK for JavaScript and TypeScript

The official JavaScript and TypeScript SDK for the
[TradeSmart API V2](https://apidocs.tradesmartonline.in/v2/), from TradeSmart Fintech Securities
Limited. Log in, read your account, find instruments, place and manage orders, and stream live prices
and order updates from Node.js; option Greeks and analytics; an offline broker for tests. Version
**2.0.0**. **TradeSmart SDK behaviour 2.0 — full.**

## Install

Node.js 22.12 or newer:

```bash
npm install tradesmart
```

You need a TradeSmart account and an API app (App Key and
Secret Key), which you create yourself, free, on the
[TradeSmart web platform](https://web.tradesmartonline.in/api). Register your static IP, and
`http://127.0.0.1:8080/callback` as the Redirect URL.

No TradeSmart account yet? [Open one online](https://signup.tradesmartonline.in/?utm_source=TypeScriptSDK&utm_medium=Organic&utm_campaign=SDK_Open_Demat&utm_content=readme&channel=Organic&platform=web).

## Quick start

Log in once a day (the token is valid until 06:00 IST) with `npx tradesmart login`, or set `TRADESMART_CLIENT_ID` and
`TRADESMART_ACCESS_TOKEN`. The command saves the same login file the Python SDK's login
command writes, so one login serves both
([details](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/getting-started.md#3-log-in-once-a-day)).
Then (_illustrative_):

```ts
import { TradeSmart } from "tradesmart";

const client = TradeSmart.fromEnv(); // uses the saved login
try {
  console.log((await client.profile()).userId);
  console.log((await client.margins()).cash?.toFixed(2));
} finally {
  await client.close();
}
```

## Next steps

- **[Your first order in 10 minutes](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/getting-started.md)**:
  API access, login, and a first order placed, checked, modified and cancelled.
- **[User guide](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/sdk-javascript/docs/README.md)**:
  orders, streaming, instruments, errors, configuration and reference.
- **[Examples](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/tree/main/sdk-javascript/examples)**:
  runnable scripts.
- **[`docs/`](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/docs/README.md)**:
  language-neutral documentation, including
  [API access and login](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/docs/api-access.md).
- **[`specifications/`](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/tree/main/specifications)**:
  the behaviour contract, conformance vectors and fixtures every TradeSmart SDK follows.

## Repository layout

| Folder                                                                                                 | What is in it                                                 |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [`sdk-javascript/`](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/tree/main/sdk-javascript) | The SDK: source, tests, user guide, examples                  |
| [`specifications/`](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/tree/main/specifications) | The language-neutral behaviour contract, vectors and fixtures |
| [`docs/`](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/tree/main/docs)                     | Language-neutral documentation                                |

## Support

- Bugs and questions: [GitHub issues](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/issues).
- Security issues: [SECURITY.md](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/SECURITY.md).
- Account and API access: `support@tradesmartonline.in`.
- Contributing: [CONTRIBUTING.md](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/CONTRIBUTING.md).

## Licence

Apache License 2.0, see [LICENSE](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/LICENSE)
and [NOTICE](https://github.com/trade-smart/TradeSmart-JavaScript-SDK/blob/main/NOTICE).
Copyright (c) 2026 TradeSmart Fintech Securities Limited.
