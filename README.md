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

## Quick Start (Goto Wrapper)

```ts
import { chromium } from "playwright";
import { agentConnect, startDynamicProxy } from "@aluvia-connect/agent-connect";

// Start local proxy-chain server (random free port)
const dyn = await startDynamicProxy();

// Launch browser using ONLY the local proxy initially (direct connection upstream)
const browser = await chromium.launch({ proxy: { server: dyn.url } });
const context = await browser.newContext();
const page = await context.newPage();

const { page: samePage } = await agentConnect(page, {
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

- The first attempt is direct (no upstream proxy). On failure, we fetch a proxy and call `dynamicProxy.setUpstream()` internally.
- Subsequent retries reuse the same browser & page; cookies and session data persist.
- Provide your own `proxyProvider` if you do not want to use the Aluvia API.
- The dynamic proxy closes automatically when the Playwright `BrowserContext` closes (also when `browser.close()` cascades). You can call `dyn.close()` manually too.

You can integrate this with any proxy API or local pool, as long as it returns a `server`, `username`, and `password`.

## Event-Driven Retry (EventRunner)

If you prefer not to wrap `page.goto()` and instead automatically react to failed network/navigation requests, use the event-based runner.

`EventRunner` listens to Playwright events on a `BrowserContext` and triggers retries when a page emits a `requestfailed` event for a navigation/document request whose failure text matches your retry patterns.

### When to Use
- Use `agentConnectEvents()` when you want passive, centralized retry handling for all pages in a context without changing existing code that calls `page.goto()`.
- Use `agentConnect()` when you want explicit control per navigation call and structured results (`{ response, page }`).

### What It Does
- Tracks every page opened in the context (`runner.getTrackedPages()`).
- On `requestfailed` for a `document` / main-frame resource (navigation failure), checks error text against your `retryOn` patterns.
- Rotates upstream proxy via the dynamic proxy and performs a `page.reload()` (fallback to `page.goto(lastUrl)`) with exponential backoff and jitter until success or max retries reached.
- Automatically closes the dynamic proxy when the context closes.
- Prevents concurrent overlapping retries per page.

### Usage

```ts
import { chromium } from 'playwright';
import { startDynamicProxy, agentConnectEvents } from '@aluvia-connect/agent-connect';

const dyn = await startDynamicProxy();
const browser = await chromium.launch({ proxy: { server: dyn.url } });
const context = await browser.newContext();

// Attach event-driven retry logic
const runner = agentConnectEvents(context, {
  dynamicProxy: dyn,
  maxRetries: 3,
  backoffMs: 250,
  retryOn: ['Timeout', /ECONNRESET/, /net::ERR/],
  onRetry: (attempt, max, last) => {
    console.log(`(events) retry ${attempt}/${max}`, last);
  },
  onProxyLoaded: (proxy) => console.log('Loaded upstream', proxy.server),
});

const page = await context.newPage();
await page.goto('https://example.com'); // normal usage
// If the navigation or subsequent document request fails and matches patterns, EventRunner will retry automatically.

// Access tracked pages if needed:
console.log('Tracked pages:', runner.getTrackedPages().length);

await browser.close(); // dynamic proxy auto-closed
```

### API: `agentConnectEvents(context, options)`
Accepts the same option names as `agentConnect`, plus:
- `dynamicProxy` (required): The dynamic proxy returned by `startDynamicProxy()`.

Returns an `EventRunner` instance with:
- `getTrackedPages(): Page[]` – snapshot of pages seen so far.

### Retry Semantics
- Only retries failures where `request.resourceType()` is one of: `document`, `frame`, `main_frame`.
- Matching is performed against the failure's `errorText` plus any error properties message/code/name if present.
- Exponential backoff formula: `backoffMs * 2^attempt + random(0–100)` (same as the goto wrapper).

### Limitations
- Does not capture low-level socket errors that never surface as `requestfailed` events.
- Non-navigation requests (e.g. images, scripts) are ignored to avoid excessive reload loops.
- Assumes the last attempted URL is still valid for `reload()`; falls back to `goto(url)` if `reload` is not available.

## API Key Setup

This SDK uses an Aluvia API key to fetch proxies when retries occur.
Get your key from your Aluvia account's [Dev Tools page](https://dashboard.aluvia.io/tools)
and set it in .env:

```bash
ALUVIA_API_KEY=your_aluvia_api_key
```

## Configuration

You can control how `agentConnect` and `agentConnectEvents` behave using environment variables or options passed in code.
The environment variables set defaults globally, while the TypeScript options let you override them per call.

### Environment Variables

| Variable             | Description                                                                              | Default                                 |
| -------------------- | ---------------------------------------------------------------------------------------- |-----------------------------------------|
| `ALUVIA_API_KEY`     | Required unless you provide a custom `proxyProvider`. Used to fetch proxies from Aluvia. | _none_                                  |
| `ALUVIA_MAX_RETRIES` | Number of retry attempts after the first failed navigation.                              | `2`                                     |
| `ALUVIA_BACKOFF_MS`  | Base delay (ms) between retries, grows exponentially with jitter.                        | `300`                                   |
| `ALUVIA_RETRY_ON`    | Comma-separated list of retryable error substrings.                                      | `ECONNRESET,ETIMEDOUT,net::ERR,Timeout` |

#### Example `.env`

```env
ALUVIA_API_KEY=your_aluvia_api_key
ALUVIA_MAX_RETRIES=1
ALUVIA_BACKOFF_MS=500
ALUVIA_RETRY_ON=ECONNRESET,ETIMEDOUT,net::ERR,Timeout
```

### Options

You can also configure behavior programmatically by passing options to `agentConnect()` or `agentConnectEvents()`.

```typescript
import { agentConnect } from "@aluvia-connect/agent-connect";

const { response, page } = await agentConnect(page, {
  maxRetries: 3,
  backoffMs: 500,
  retryOn: ["ECONNRESET", /403/],
  onRetry: (attempt, maxRetries, lastError) => {
    console.log(
      `Retry attempt ${attempt} of ${maxRetries} due to error:`,
      lastError
    );
  },
  onProxyLoaded: (proxy) => {
    console.log(`Proxy loaded: ${proxy.server}`);
  },
});
```

#### Available Options

| Option            | Type                                                                                 | Default                                  | Description                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------ |------------------------------------------| ------------------------------------------------------------------------------------------------------------- |
| `maxRetries`      | `number`                                                                             | `process.env.ALUVIA_MAX_RETRIES` or `2`  | Number of retry attempts after the first failure.                                                             |
| `backoffMs`       | `number`                                                                             | `process.env.ALUVIA_BACKOFF_MS` or `300` | Base delay (in ms) between retries, grows exponentially with jitter.                                          |
| `retryOn`         | `(string | RegExp)[]`                                                               | `process.env.ALUVIA_RETRY_ON`            | Error patterns considered retryable.                                                                          |
| `proxyProvider`   | `ProxyProvider`                                                                      | Uses Aluvia SDK                          | Custom proxy provider that returns proxy credentials.                                                         |
| `onRetry`         | `(attempt: number, maxRetries: number, lastError: unknown) => void | Promise<void>` | `undefined`                              | Callback invoked before each retry attempt.                                                                   |
| `onProxyLoaded`   | `(proxy: ProxySettings) => void | Promise<void>`                                    | `undefined`                              | Callback fired after a proxy has been successfully fetched.                                                   |

#### Custom Proxy Provider Example

```typescript
const myProxyProvider = {
  async get() {
    return {
      server: "http://myproxy.example.com:8000",
      username: "user123",
      password: "secret",
    };
  },
};

const { response, page } = await agentConnect(page, {
  proxyProvider: myProxyProvider,
  maxRetries: 3,
});
```

## Examples

### Wikipedia Random Article (EventRunner)
Event-driven retry usage to scrape a random Wikipedia article without wrapping `page.goto()`. Automatically reloads on navigation/network failures matching retry patterns.

JavaScript:
```
node examples/wikipedia-random-events.js
```
TypeScript:
```
ts-node examples/wikipediaRandomScrape.ts
```
(Or compile with `tsc` first.)

Output includes article title, first paragraph and headings. Adjust `retryOn`, `maxRetries`, or provide a custom `proxyProvider` as needed.

### Running Examples Locally
Before running examples that import the published entry (`@aluvia-connect/agent-connect`), build the project:

```bash
npm install
npm run build
npx playwright install chromium
```

Run headless (default):
```bash
node examples/wikipedia-random-events.js
```

Run with UI (set HEADLESS=false):
```bash
HEADLESS=false node examples/wikipedia-random-events.js
```

## Requirements

- Node.js >= 18
- Playwright
- Aluvia API key (_if not using a custom proxy provider_)

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
