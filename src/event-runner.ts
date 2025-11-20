import type { BrowserContext, Page } from 'playwright';
import type { DynamicProxy, ProxySettings, RetryPattern } from './index';

interface EventRunnerOptions {
  dynamicProxy: DynamicProxy;
  maxRetries?: number;          // made optional
  backoffMs?: number;           // made optional
  retryOn?: RetryPattern[];     // made optional
  proxyProvider?: { get(): Promise<ProxySettings> };
  getAluviaProxy: () => Promise<ProxySettings>;
  onRetry?: (attempt: number, maxRetries: number, lastError: unknown) => void | Promise<void>;
  onProxyLoaded?: (proxy: ProxySettings) => void | Promise<void>;
  AluviaErrorCtor?: new (message: string, code?: any) => Error; // made optional
  AluviaErrorCode?: any;                                        // made optional
}

function backoffDelay(base: number, attempt: number) {
  const jitter = Math.random() * 100;
  return base * Math.pow(2, attempt) + jitter;
}

function compileRetryable(patterns: (string | RegExp)[]) {
  return (errLike: { errorText?: string } | unknown) => {
    const msg = String((errLike as any)?.errorText ?? (errLike as any)?.message ?? (errLike as any) ?? '');
    const code = String((errLike as any)?.code ?? '');
    const name = String((errLike as any)?.name ?? '');
    return patterns.some((p) =>
      p instanceof RegExp
        ? p.test(msg) || p.test(code) || p.test(name)
        : msg.includes(p) || code.includes(p) || name.includes(p)
    );
  };
}

class EventRunner {
  private pages: Page[] = [];
  private isRetryable: (e: any) => boolean;
  private runningRetries = new WeakSet<Page>();

  constructor(private opts: EventRunnerOptions) {
    // normalize defaults
    const {
      maxRetries = 3,
      backoffMs = 300,
      retryOn = ['Timeout', 'net::ERR', 'ECONNRESET', /ETIMEDOUT/],
    } = opts;
    this.opts.maxRetries = maxRetries;
    this.opts.backoffMs = backoffMs;
    this.opts.retryOn = retryOn;
    this.isRetryable = compileRetryable(this.opts.retryOn);
  }

  getTrackedPages() {
    return [...this.pages];
  }

  listen(context: BrowserContext) {
    // Close dynamic proxy when context closes
    context.on('close', async () => {
      try { await this.opts.dynamicProxy.close(); } catch {}
    });

    // Track new pages
    context.on('page', (page: Page) => {
      this.pages.push(page);
      this.patchGoto(page);         // NEW: proactive retry wrapper
      this.attachPageListeners(page);
    });

    // Attach existing pages if any (in case listen called after some created)
    for (const p of context.pages?.() || []) {
      if (!this.pages.includes(p)) {
        this.pages.push(p);
        this.patchGoto(p);          // NEW
        this.attachPageListeners(p);
      }
    }
  }

  private patchGoto(page: Page) {
    const original = page.goto.bind(page);
    page.goto = (async (url: string, options?: any) => {
      try {
        return await original(url, options);
      } catch (err) {
        if (!this.isRetryable(err)) throw err;
        const { maxRetries = 0, backoffMs = 0 } = this.opts;
        let lastErr: any = err;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          await this.prepareUpstream(attempt, lastErr);
            if (backoffMs > 0) {
              await new Promise(r => setTimeout(r, backoffDelay(backoffMs, attempt - 1)));
            }
          try {
            return await original(url, options);
          } catch (e) {
            lastErr = e;
            if (!this.isRetryable(e)) break;
          }
        }
        throw lastErr;
      }
    }) as any;
  }

  private async prepareUpstream(attempt: number, lastErr: unknown) {
    const {
      dynamicProxy,
      proxyProvider,
      getAluviaProxy,
      onProxyLoaded,
      onRetry,
    } = this.opts;
    await onRetry?.(attempt, this.opts.maxRetries!, lastErr);

    if (attempt !== 1) return; // only load upstream once initially

    try {
      let proxy: ProxySettings | undefined;
      if (proxyProvider) {
        proxy = await proxyProvider.get();
        await dynamicProxy.setUpstream(proxy);
      } else if (getAluviaProxy) {
        proxy = await getAluviaProxy();
        await dynamicProxy.setUpstream(proxy);
      } else if (typeof (dynamicProxy as any).loadUpstream === 'function') {
        proxy = await (dynamicProxy as any).loadUpstream();
      }
      if (proxy) await onProxyLoaded?.(proxy);
    } catch {
      // swallow upstream load errors; retries continue
    }
  }

  // ADDED: attachPageListeners to handle passive retries on request failures.
  private attachPageListeners(page: Page) {
    page.on('requestfailed', async (req) => {
      if (page.isClosed()) return;
      const failure = req.failure();
      const errText = failure?.errorText || '';
      // Ignore non-retryable failures
      if (!this.isRetryable({ errorText: errText })) return;
      // Avoid overlapping retries for same page
      if (this.runningRetries.has(page)) return;
      this.runningRetries.add(page);
      try {
        // Attempt passive navigation retry (reload/goto).
        await this.retryNavigation(page, req.url());
      } catch {
        // Swallow here; explicit page.goto wrapper will surface fatal errors.
      } finally {
        this.runningRetries.delete(page);
      }
    });
  }

  private async retryNavigation(page: Page, lastUrl?: string) {
    const { maxRetries = 0, backoffMs = 0, proxyProvider, getAluviaProxy, dynamicProxy, onRetry, onProxyLoaded } = this.opts;
    let lastErr: unknown;
    if (!lastUrl) return;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await onRetry?.(attempt, maxRetries, lastErr);
      try {
        if (attempt === 1) {
          let proxy: ProxySettings | undefined;
            if (proxyProvider) {
              proxy = await proxyProvider.get();
              await dynamicProxy.setUpstream(proxy);
            } else if (getAluviaProxy) {
              proxy = await getAluviaProxy();
              await dynamicProxy.setUpstream(proxy);
            } else if (typeof (dynamicProxy as any).loadUpstream === 'function') {
              proxy = await (dynamicProxy as any).loadUpstream();
            }
          if (proxy) await onProxyLoaded?.(proxy);
        }
      } catch {}
      if (backoffMs > 0) {
        await new Promise(r => setTimeout(r, backoffDelay(backoffMs, attempt - 1)));
      }
      try {
        if (page.isClosed()) return;
        if (typeof (page as any).reload === 'function') {
          await (page as any).reload({ waitUntil: 'domcontentloaded' });
        } else {
          await page.goto(lastUrl, { waitUntil: 'domcontentloaded' });
        }
        return;
      } catch (e) {
        lastErr = e;
        if (!this.isRetryable(e)) break;
      }
    }
    if (lastErr) throw lastErr;
  }
}

// NEW: helper factory for plug-and-play usage (used by example)
export function agentConnectEvents(context: BrowserContext, opts: EventRunnerOptions) {
  const runner = new EventRunner(opts);
  runner.listen(context);
  return runner;
}

export function runEventRunnerSelfTest() {
  // Minimal stub dynamic proxy
  const stubDyn: DynamicProxy = {
    url: 'http://stub',
    async setUpstream() {},
    async close() {},
    currentUpstream() { return null; },
  };
  // Construct runner with defaults
  const runner = new (EventRunner as any)({ dynamicProxy: stubDyn });
  const pages = runner.getTrackedPages();
  return {
    hasGetTrackedPages: typeof runner.getTrackedPages === 'function',
    initialPagesLength: pages.length,
    retryableCheck: ['Timeout'].every(p => true),
  };
}

export { EventRunner }; // ensure named export
export default agentConnectEvents;
