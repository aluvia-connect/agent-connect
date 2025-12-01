# Agent Connect

[![npm version](https://badge.fury.io/js/@aluvia-connect%2Fagent-connect.svg)](https://badge.fury.io/js/@aluvia-connect%2Fagent-connect)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org)

Retry failed [Playwright](https://playwright.dev) navigations automatically with proxy fallback.

[Read the full documentation](https://docs.aluvia.io/docs/using-aluvia/agent-connect-sdk)

## Installation

```bash
npm install @aluvia-connect/agent-connect
```

```bash
yarn add @aluvia-connect/agent-connect
```

```bash
pnpm add @aluvia-connect/agent-connect
```

## Quick Start

```ts
import { chromium } from "playwright";
import { agentConnectGoTo, DynamicProxy } from "@aluvia-connect/agent-connect";

// Start local dynamic proxy (random free port)
const dyn = await DynamicProxy.start();

// Launch browser using the local proxy; upstream is initially direct
const browser = await chromium.launch({ proxy: { server: dyn.url } });
const context = await browser.newContext();
const page = await context.newPage();

const { page: samePage } = await agentConnectGoTo(page, {
  dynamicProxy: dyn,
  maxRetries: 2,
  retryOn: ["Timeout", /net::ERR/],
  onProxyLoaded: (p) => console.log("Upstream proxy loaded", p.server),
  onRetry: (a, m) => console.log(`Retry ${a}/${m}`),
}).goto("https://blocked-website.example");

console.log(await samePage.title());
await browser.close();
```

Notes:

- The first attempt is direct (no upstream proxy). On failure, a proxy is fetched and `dynamicProxy.setUpstream()` is called internally.
- Subsequent retries reuse the same browser & page; cookies and session data persist.
- Provide your own `proxyProvider` if you do not want to use the Aluvia API.
- The dynamic proxy closes automatically when the Playwright context closes; you can also call `dyn.close()` manually.

You can integrate this with any proxy API or local pool that returns `server`, `username`, and `password`.

## Exports

From `@aluvia-connect/agent-connect` you can import:

- `agentConnectGoTo(page, options)` – wraps Playwright navigation with retry + proxy fallback.
- `agentConnect` – backward-compatible alias of `agentConnectGoTo`.
- `DynamicProxy` – class to run a local proxy that can change upstream without relaunching the browser.
- `startDynamicProxy(port?)` – convenience factory calling `DynamicProxy.start(port?)`.
- `agentConnectListener(context, options)` – emits page success/error events for a `BrowserContext`.

## Aluvia Token Setup

This SDK uses an Aluvia token to fetch proxies when retries occur. Find your token on your Aluvia account's [credentials](https://dashboard.aluvia.io/credentials) page.

Set your token key in a `.env` file:

```env
ALUVIA_TOKEN=your_aluvia_token
```

## Configuration

You can control how navigation retries behave using environment variables or options passed in code. The environment variables set defaults globally, while the TypeScript options let you override them per call.

### Environment Variables

| Variable             | Description                                                                              | Default                                 |
|----------------------| ---------------------------------------------------------------------------------------- |-----------------------------------------|
| `ALUVIA_TOKEN`       | Required unless you provide a custom `proxyProvider`. Used to fetch proxies from Aluvia. | _none_                                  |
| `ALUVIA_MAX_RETRIES` | Number of retry attempts after the first failed navigation.                              | `2`                                     |
| `ALUVIA_BACKOFF_MS`  | Base delay (ms) between retries, grows exponentially with jitter.                        | `300`                                   |
| `ALUVIA_RETRY_ON`    | Comma-separated list of retryable error substrings.                                      | `ECONNRESET,ETIMEDOUT,net::ERR,Timeout` |

#### Example `.env`

```env
ALUVIA_TOKEN=your_aluvia_token
ALUVIA_MAX_RETRIES=1
ALUVIA_BACKOFF_MS=500
ALUVIA_RETRY_ON=ECONNRESET,ETIMEDOUT,net::ERR,Timeout
```

## API

### Navigation with Retry: `agentConnectGoTo`

```ts
import { agentConnectGoTo, DynamicProxy } from "@aluvia-connect/agent-connect";

const dyn = await DynamicProxy.start();
const { response, page } = await agentConnectGoTo(page, {
  dynamicProxy: dyn,
  maxRetries: 3,
  backoffMs: 500,
  retryOn: ["ECONNRESET", /403/],
  onRetry: (attempt, maxRetries, lastError) => {
    console.log(`Retry ${attempt}/${maxRetries}`, lastError);
  },
  onProxyLoaded: (proxy) => {
    console.log(`Proxy loaded: ${proxy.server}`);
  },
}).goto("https://example.com");
```

Backward-compatible alias:

```ts
import { agentConnect } from "@aluvia-connect/agent-connect";
// agentConnect === agentConnectGoTo
```

#### Options

| Option            | Type                                                                                 | Default                                  | Description                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------ |------------------------------------------| ------------------------------------------------------------------------------------------------------------- |
| `dynamicProxy`    | `DynamicProxy`                                                                       | required                                 | Local proxy whose upstream can be switched between retries.                                                  |
| `maxRetries`      | `number`                                                                             | `process.env.ALUVIA_MAX_RETRIES` or `2`  | Number of retry attempts after the first failure.                                                             |
| `backoffMs`       | `number`                                                                             | `process.env.ALUVIA_BACKOFF_MS` or `300` | Base delay (in ms) between retries, grows exponentially with jitter.                                          |
| `retryOn`         | `(string \| RegExp)[]`                                                               | `process.env.ALUVIA_RETRY_ON`            | Error patterns considered retryable.                                                                          |
| `proxyProvider`   | `ProxyProvider`                                                                      | Uses Aluvia SDK                          | Custom proxy provider that returns proxy credentials.                                                         |
| `onRetry`         | `(attempt: number, maxRetries: number, lastError: unknown) => void \| Promise<void>` | `undefined`                              | Callback invoked before each retry attempt.                                                                   |
| `onProxyLoaded`   | `(proxy: ProxySettings) => void \| Promise<void>`                                    | `undefined`                              | Callback fired after a proxy has been successfully fetched (either from the Aluvia API or a custom provider). |

### Dynamic Proxy: `DynamicProxy`

The `DynamicProxy` class runs a local proxy-server using `proxy-chain`. It allows changing the upstream proxy at runtime without relaunching the browser.

```ts
import { DynamicProxy } from "@aluvia-connect/agent-connect";

// Start on random free port
const dyn = await DynamicProxy.start();
console.log(dyn.url); // http://127.0.0.1:<port>

// Set upstream
await dyn.setUpstream({
  server: "http://myproxy.example.com:8000",
  username: "user123",
  password: "secret",
});

// Optional: get current upstream
console.log(dyn.currentUpstream());

// Close when done
await dyn.close();
```

Convenience factory:

```ts
import { startDynamicProxy } from "@aluvia-connect/agent-connect";
const dyn = await startDynamicProxy(); // Equivalent to DynamicProxy.start()
```

### Status & Error Listener: `agentConnectListener`

You can observe page-level load successes and selected Playwright request failures using the `agentConnectListener()` helper. It attaches to every existing and future page in a `BrowserContext` and emits an `aluviastatus` event.

```ts
import { agentConnectListener } from "@aluvia-connect/agent-connect";

const context = await browser.newContext();
const statusEmitter = agentConnectListener(context, { errorOn: ["TimeoutError", "ECONNRESET"] });

statusEmitter.on("aluviastatus", (payload) => {
  if (payload.state === "success") {
    console.log("Page load completed");
  } else if (payload.state === "error") {
    console.warn("Monitored request failed:", payload.request.url());
  }
});
```

#### Event Payloads

- On page load reaching the `load` state: `{ state: "success" }`
- On a failed network request whose error text contains one of the configured patterns: `{ state: "error", request: Request }`

### Notes

- The listener is per `BrowserContext`; repeated calls with the same context return the same internal emitter.
- Newly created pages (`context.on('page')`) are automatically wired—no manual re-attachment needed.
- You can combine this with `agentConnectGoTo()` to observe navigation health while retries occur.
- All events are emitted using Node.js `EventEmitter`; remove listeners with `statusEmitter.removeListener(...)` if required.

## Requirements

- Node.js >= 18
- Playwright
- Aluvia token (_if not using a custom proxy provider_)

## About Aluvia

[Aluvia](https://www.aluvia.io/) provides real mobile proxy networks for developers and data teams, built for web automation, testing, and scraping with real device IPs.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.MD](CONTRIBUTING.MD) for guidelines.

- Fork the repo and create your branch.
- Write clear commit messages.
- Add tests for new features.
- Open a pull request.

## Support

For bugs, feature requests, or questions, please open an issue on [GitHub](https://github.com/aluvia-connect/agent-connect/issues).

For commercial support or proxy questions, visit [Aluvia](https://www.aluvia.io/).

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Author

Aluvia - [https://www.aluvia.io/](https://www.aluvia.io/)
