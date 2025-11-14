import type { BrowserContext, Page } from 'playwright';
import type { DynamicProxy, ProxySettings, RetryPattern } from './index';

interface EventRunnerOptions {
  dynamicProxy: DynamicProxy;
  maxRetries: number;
  backoffMs: number;
  retryOn: RetryPattern[];
  proxyProvider?: { get(): Promise<ProxySettings> };
  getAluviaProxy: () => Promise<ProxySettings>;
  onRetry?: (attempt: number, maxRetries: number, lastError: unknown) => void | Promise<void>;
  onProxyLoaded?: (proxy: ProxySettings) => void | Promise<void>;
  AluviaErrorCtor: new (message: string, code?: any) => Error;
  AluviaErrorCode: any;
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

export class EventRunner {
  private pages: Page[] = [];
  private isRetryable: (e: any) => boolean;
  private runningRetries = new WeakSet<Page>();

  constructor(private opts: EventRunnerOptions) {
    this.isRetryable = compileRetryable(opts.retryOn);
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
      this.attachPageListeners(page);
    });

    // Attach existing pages if any (in case listen called after some created)
    for (const p of context.pages?.() || []) {
      if (!this.pages.includes(p)) {
        this.pages.push(p);
        this.attachPageListeners(p);
      }
    }
  }

  private attachPageListeners(page: Page) {
    page.on('requestfailed', async (request: any) => {
      // Avoid parallel retries per page
      if (this.runningRetries.has(page)) return;

      const failure = request.failure?.();
      const errorText = failure?.errorText || '';
      const resourceType = request.resourceType?.() || '';

      // Only act on document/navigation failures
      if (!['document', 'frame', 'main_frame'].includes(resourceType)) return;

      if (!this.isRetryable({ errorText })) return;

      this.runningRetries.add(page);
      try {
        await this.retryNavigation(page, request.url?.());
      } finally {
        this.runningRetries.delete(page);
      }
    });
  }

  private async retryNavigation(page: Page, lastUrl?: string) {
    const { maxRetries, backoffMs, proxyProvider, getAluviaProxy, dynamicProxy, onRetry, onProxyLoaded, AluviaErrorCtor, AluviaErrorCode } = this.opts;
    let lastErr: unknown;

    if (!lastUrl) {
      // Attempt to reconstruct from page content or skip
      return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const proxy = await (proxyProvider?.get() ?? getAluviaProxy()).catch((err) => {
        lastErr = err;
        return undefined;
      });

      if (!proxy) {
        throw new AluviaErrorCtor(
          'Failed to obtain a proxy for retry attempts. Check your balance and proxy pool at https://dashboard.aluvia.io/.',
          AluviaErrorCode.ProxyFetchFailed
        );
      } else {
        await onProxyLoaded?.(proxy);
      }

      await dynamicProxy.setUpstream(proxy);

      if (backoffMs > 0) {
        const delay = backoffDelay(backoffMs, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
      await onRetry?.(attempt, maxRetries, lastErr);

      try {
        // Prefer reload if available, fallback to goto
        if (typeof (page as any).reload === 'function') {
          await (page as any).reload({ waitUntil: 'domcontentloaded' });
        } else {
          await page.goto(lastUrl, { waitUntil: 'domcontentloaded' });
        }
        // success -> stop
        return;
      } catch (err) {
        lastErr = err;
        if (!this.isRetryable(err)) break;
        continue; // next retry
      }
    }

    if (lastErr instanceof Error) throw lastErr;
    if (lastErr) throw new Error(String(lastErr));
    throw new Error('Navigation retry failed');
  }
}

export default EventRunner;

