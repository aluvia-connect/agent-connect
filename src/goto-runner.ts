import type { Page, Response, BrowserContext } from "playwright";
import type { DynamicProxy, ProxySettings, RetryPattern } from "./index"; // Types only; runtime safe in TS emit

const DEFAULT_GOTO_TIMEOUT_MS = 15_000;
const GOTO_ORIGINAL = Symbol.for("aluvia.gotoOriginal");
const CONTEXT_LISTENER_ATTACHED = new WeakSet<BrowserContext>();

// Re-implemented helpers locally to avoid widening public API surface
function backoffDelay(base: number, attempt: number) {
  const jitter = Math.random() * 100;
  return base * Math.pow(2, attempt) + jitter;
}

function compileRetryable(patterns: (string | RegExp)[]) {
  return (err: unknown) => {
    if (!err) return false;
    const msg = String((err as any)?.message ?? (err as any) ?? "");
    const code = String((err as any)?.code ?? "");
    const name = String((err as any)?.name ?? "");
    return patterns.some((p) =>
      p instanceof RegExp
        ? p.test(msg) || p.test(code) || p.test(name)
        : msg.includes(p) || code.includes(p) || name.includes(p)
    );
  };
}

export type GoToOptions = NonNullable<Parameters<Page["goto"]>[1]>;

export interface GotoRunnerDeps {
  dynamicProxy: DynamicProxy;
  page: Page;
  maxRetries: number;
  backoffMs: number;
  retryOn: RetryPattern[];
  proxyProvider?: { get(): Promise<ProxySettings> };
  onRetry?: (attempt: number, maxRetries: number, lastError: unknown) => void | Promise<void>;
  onProxyLoaded?: (proxy: ProxySettings) => void | Promise<void>;
  getAluviaProxy: () => Promise<ProxySettings>;
  AluviaErrorCtor: new (message: string, code?: any) => Error; // for throwing balance errors consistently
  AluviaErrorCode: any;
}

export class GotoRunner {
  private isRetryable: (err: unknown) => boolean;
  constructor(private deps: GotoRunnerDeps) {
    this.isRetryable = compileRetryable(deps.retryOn);
  }

  private rawGoto(p: Page) {
    return ((p as any)[GOTO_ORIGINAL]?.bind(p) ?? p.goto.bind(p)) as Page["goto"];
  }

  async goto(url: string, gotoOptions?: GoToOptions): Promise<{ response: Response | null; page: Page }> {
    const { page, dynamicProxy, maxRetries, backoffMs, proxyProvider, onRetry, onProxyLoaded, getAluviaProxy, AluviaErrorCtor, AluviaErrorCode } = this.deps;
    const isRetryable = this.isRetryable;
    let lastErr: unknown;

    if (dynamicProxy) {
      const ctx = page.context();
      if (!CONTEXT_LISTENER_ATTACHED.has(ctx)) {
        ctx.on("close", async () => {
          try { await dynamicProxy.close(); } catch {}
        });
        CONTEXT_LISTENER_ATTACHED.add(ctx);
      }
    }

    try {
      const response = await this.rawGoto(page)(url, {
        ...(gotoOptions ?? {}),
        timeout: gotoOptions?.timeout ?? DEFAULT_GOTO_TIMEOUT_MS,
        waitUntil: gotoOptions?.waitUntil ?? "domcontentloaded",
      });
      return { response: response ?? null, page };
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) {
        throw err;
      }
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const proxy = await (proxyProvider?.get() ?? getAluviaProxy()).catch((err) => {
        lastErr = err;
        return undefined;
      });

      if (!proxy) {
        throw new AluviaErrorCtor(
          "Failed to obtain a proxy for retry attempts. Check your balance and proxy pool at https://dashboard.aluvia.io/.",
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
        const response = await this.rawGoto(page)(url, {
          ...(gotoOptions ?? {}),
          timeout: gotoOptions?.timeout ?? DEFAULT_GOTO_TIMEOUT_MS,
          waitUntil: gotoOptions?.waitUntil ?? "domcontentloaded",
        });
        return { response: response ?? null, page };
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) break;
        continue;
      }
    }

    if (lastErr instanceof Error) throw lastErr;
    throw new Error(lastErr ? String(lastErr) : "Navigation failed");
  }
}
