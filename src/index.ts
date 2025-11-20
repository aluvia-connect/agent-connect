import type { Page, Response } from "playwright";
import { Server as ProxyChainServer } from "proxy-chain";
import { GotoRunner } from "./goto-runner";
import { EventRunner } from './event-runner';

const ENV_MAX_RETRIES = Math.max(0, parseInt(process.env.ALUVIA_MAX_RETRIES || "2", 10)); // prettier-ignore
const ENV_BACKOFF_MS  = Math.max(0, parseInt(process.env.ALUVIA_BACKOFF_MS  || "300", 10)); // prettier-ignore
const ENV_RETRY_ON = (
  process.env.ALUVIA_RETRY_ON ?? "ECONNRESET,ETIMEDOUT,net::ERR,Timeout,net::ERR_ABORTED"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

/* Pre-compile retry patterns for performance & correctness */
const DEFAULT_RETRY_PATTERNS: (string | RegExp)[] = ENV_RETRY_ON.map((value) =>
  value.startsWith("/") && value.endsWith("/")
    ? new RegExp(value.slice(1, -1))
    : value
);

export type RetryPattern = string | RegExp;

type GoToOptions = NonNullable<Parameters<Page["goto"]>[1]>;

export interface AgentConnectRunner {
  goto(
    url: string,
    options?: GoToOptions
  ): Promise<{ response: Response | null; page: Page }>;
}

export type ProxySettings = {
  server: string;
  username?: string;
  password?: string;
};

export interface ProxyProvider {
  get(): Promise<ProxySettings>;
}

enum AluviaErrorCode {
  NoApiKey = "ALUVIA_NO_API_KEY",
  NoProxy = "ALUVIA_NO_PROXIES",
  ProxyFetchFailed = "ALUVIA_PROXY_FETCH_FAILED",
  InsufficientBalance = "ALUVIA_INSUFFICIENT_BALANCE",
  BalanceFetchFailed = "ALUVIA_BALANCE_FETCH_FAILED",
  NoDynamicProxy = "ALUVIA_NO_DYNAMIC_PROXY",
}

export class AluviaError extends Error {
  code?: AluviaErrorCode;
  constructor(message: string, code?: AluviaErrorCode) {
    super(message);
    this.name = "AluviaError";
    this.code = code;
  }
}

export interface AgentConnectOptions {
  /**
   * Dynamic proxy. Retries will switch upstream proxy via this local proxy.
   *
   * To use: const dyn = await startDynamicProxy();
   * chromium.launch({ proxy: { server: dyn.url } })
   * Then pass { dynamicProxy: dyn } to agentConnect().
   */
  dynamicProxy: DynamicProxy;

  /**
   * Number of retry attempts after the first failed navigation.
   *
   * The first `page.goto()` is always attempted without a proxy.
   * If it fails with a retryable error (as defined by `retryOn`),
   * the helper will fetch a new proxy and relaunch the browser.
   *
   * @default process.env.ALUVIA_MAX_RETRIES || 2
   * @example
   * // Try up to 3 proxy relaunches after the first failure
   * { maxRetries: 3 }
   */
  maxRetries?: number;

  /**
   * Base delay (in milliseconds) for exponential backoff between retries.
   *
   * Each retry waits `backoffMs * 2^attempt + random(0–100)` before continuing.
   * Useful to avoid hammering proxy endpoints or triggering rate limits.
   *
   * @default process.env.ALUVIA_BACKOFF_MS || 300
   * @example
   * // Start with 500ms and double each time (with jitter)
   * { backoffMs: 500 }
   */
  backoffMs?: number;

  /**
   * List of error patterns that are considered retryable.
   *
   * A pattern can be a string or a regular expression. When a navigation error’s
   * message, name, or code matches any of these, the helper will trigger a retry.
   *
   * @default process.env.ALUVIA_RETRY_ON
   *          or ["ECONNRESET", "ETIMEDOUT", "net::ERR", "Timeout"]
   * @example
   * // Retry on connection resets and 403 responses
   * { retryOn: ["ECONNRESET", /403/] }
   */
  retryOn?: RetryPattern[];

  /**
   * Optional custom proxy provider used to fetch proxy credentials.
   *
   * By default, `agentConnect` automatically uses the Aluvia API
   * via the `aluvia-ts-sdk` and reads the API key from
   * `process.env.ALUVIA_API_KEY`.
   *
   * Supplying your own `proxyProvider` allows you to integrate with
   * any proxy rotation service, database, or in-house pool instead.
   *
   * A proxy provider must expose a `get()` method that returns a
   * `Promise<ProxySettings>` object with `server`, and optionally
   * `username` and `password` fields.
   *
   * @default Uses the built-in Aluvia client with `process.env.ALUVIA_API_KEY`
   * @example
   * ```ts
   * import { agentConnect } from "agent-connect";
   *
   * // Custom proxy provider example
   * const myProxyProvider = {
   *   async get() {
   *     // Pull from your own proxy pool or API
   *     return {
   *       server: "http://myproxy.example.com:8000",
   *       username: "user123",
   *       password: "secret",
   *     };
   *   },
   * };
   *
   * const { response, page } = await agentConnect(page, {
   *   proxyProvider: myProxyProvider,
   *   maxRetries: 3,
   * });
   * ```
   */
  proxyProvider?: ProxyProvider;

  /**
   * Optional callback fired before each retry attempt (after backoff).
   *
   * @param attempt Current retry attempt number (1-based)
   * @param maxRetries Maximum number of retries
   * @param lastError The error that triggered the retry
   */
  onRetry?: (
    attempt: number,
    maxRetries: number,
    lastError: unknown
  ) => void | Promise<void>;

  /**
   * Optional callback fired when a proxy has been successfully fetched.
   *
   * @param proxy The proxy settings that were fetched or provided
   */
  onProxyLoaded?: (proxy: ProxySettings) => void | Promise<void>;
}

let aluviaClient: any | undefined; // lazy-loaded Aluvia client instance

async function getAluviaProxy(): Promise<ProxySettings> {
  const apiKey = process.env.ALUVIA_API_KEY || "";
  if (!apiKey) {
    throw new AluviaError(
      "Missing ALUVIA_API_KEY environment variable.",
      AluviaErrorCode.NoApiKey
    );
  }

  if (!aluviaClient) {
    // Dynamic import to play nicely with test mocks (avoids top-level evaluation before vi.mock)
    const mod: any = await import("aluvia-ts-sdk");
    const AluviaCtor = mod?.default || mod;
    aluviaClient = new AluviaCtor(apiKey);
  }

  const proxy = await aluviaClient.first();

  if (!proxy) {
    throw new AluviaError(
      "Failed to obtain a proxy for retry attempts. Check your balance and proxy pool at https://dashboard.aluvia.io/.",
      AluviaErrorCode.NoProxy
    );
  }

  const sessionId = generateSessionId();

  return {
    server: `http://${proxy.host}:${proxy.httpPort}`,
    username: `${proxy.username}-session-${sessionId}`,
    password: proxy.password,
  };
}

async function getAluviaBalance() {
  const apiKey = process.env.ALUVIA_API_KEY || "";
  if (!apiKey) {
    throw new AluviaError(
      "Missing ALUVIA_API_KEY environment variable.",
      AluviaErrorCode.NoApiKey
    );
  }

  const response = await fetch("https://api.aluvia.io/account/status", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new AluviaError(
      `Failed to fetch Aluvia account status: ${response.status} ${response.statusText}`,
      AluviaErrorCode.BalanceFetchFailed
    );
  }

  const data = await response.json();
  return data.data.balance_gb;
}

function generateSessionId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function agentConnect(
  page: Page,
  options?: AgentConnectOptions
): AgentConnectRunner {
  const {
    dynamicProxy,
    maxRetries = ENV_MAX_RETRIES,
    backoffMs = ENV_BACKOFF_MS,
    retryOn = DEFAULT_RETRY_PATTERNS,
    proxyProvider,
    onRetry,
    onProxyLoaded,
  } = options ?? {};

  if (!dynamicProxy) {
    throw new AluviaError(
      "No dynamic proxy supplied to agentConnect",
      AluviaErrorCode.NoDynamicProxy
    );
  }

  return {
    async goto(url: string, gotoOptions?: GoToOptions) {
      const runner = new GotoRunner({
        dynamicProxy,
        page,
        maxRetries,
        backoffMs,
        retryOn,
        proxyProvider,
        onRetry,
        onProxyLoaded,
        getAluviaProxy,
        AluviaErrorCtor: AluviaError,
        AluviaErrorCode,
      });
      return runner.goto(url, gotoOptions);
    },
  };
}

/**
 * Starts a local proxy-chain server which can have its upstream changed at runtime
 * without relaunching the browser. Launch Playwright with { proxy: { server: dynamic.url } }.
 */
export async function startDynamicProxy(port?: number): Promise<DynamicProxy> {
  let upstream: ProxySettings | null = null;

  const server = new ProxyChainServer({
    port: port || 0,
    prepareRequestFunction: async () => {
      if (!upstream) return {};
      let url = upstream.server.startsWith("http") ? upstream.server : `http://${upstream.server}`;
      if (upstream.username && upstream.password) {
        try {
          const u = new URL(url);
          u.username = upstream.username;
          u.password = upstream.password;
          url = u.toString();
        } catch {}
      }
      return { upstreamProxyUrl: url } as any;
    },
  });

  await server.listen();
  const address = server.server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port || 8000;
  const url = `http://127.0.0.1:${resolvedPort}`;

  return {
    url,
    async setUpstream(p: ProxySettings | null) {
      upstream = p;
    },
    async close() {
      try { await server.close(true); } catch {}
    },
    currentUpstream() { return upstream; },
  };
}

export interface DynamicProxy {
  /** Local proxy URL (host:port) to be used in Playwright launch options */
  url: string;
  /** Update upstream proxy; null disables upstream (direct connection) */
  setUpstream(proxy: ProxySettings | null): Promise<void>;
  /** Dispose the local proxy server */
  close(): Promise<void>;
  /** Returns the currently configured upstream settings (if any) */
  currentUpstream(): ProxySettings | null;
}

export { EventRunner, agentConnectEvents, runEventRunnerSelfTest } from './event-runner';
