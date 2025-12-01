import type { BrowserContext, Page, Request, Response } from "playwright";
import { EventEmitter } from "events";

// Added WeakMaps to manage per-context emitters and page sets
const CONTEXT_EMITTER = new WeakMap<BrowserContext, EventEmitter>();
const CONTEXT_PAGE_SET = new WeakMap<BrowserContext, Set<Page>>();
const FAILURE_PATTERNS = [
  /(?:^|\b)404\b/i,
  /\b403\b/i,
  /\b401\b/i,
  ///\b50[0-9]\b/i,
  /Bad Gateway/i,
  /Service Unavailable/i,
  /Internal Server Error/i,
  /Not Found/i,

  ///captcha/i,
  ///hcaptcha/i,
  ///recaptcha/i,
  /verify you are human/i,
  /Access denied/i,
  /bot detected/i,
  /unusual traffic/i,

  ///Cloudflare/i,
  /Attention Required!/i,
  ///Ray ID/i,
  /Akamai/i,
  /Incapsula/i,
  /Sucuri/i,

  /ERR_CONNECTION_RESET/i,
  /ERR_TIMED_OUT/i,
  /ERR_SSL_PROTOCOL_ERROR/i,
  /Proxy error/i,
  /Connection reset/i,
  /Timeout/i,

  /This site can’t be reached/i,
  /Check your internet connection/i
];

export interface AgentConnectOptions {
  /**
   * List of error patterns that trigger an event
   *
   * @default  ["ECONNRESET", "ETIMEDOUT", "net::ERR", "Timeout"]
   * @example
   * // Error only on connection resets
   * { errorOn: ["ECONNRESET"] }
   */
  errorOn?: Array<string>;
}

export function agentConnectListener(context: BrowserContext, options?: AgentConnectOptions): EventEmitter {
  const {
    errorOn = ["ECONNRESET", "ETIMEDOUT", "net::ERR", "Timeout"],
  } = options ?? {};

  let emitter = CONTEXT_EMITTER.get(context);
  if (emitter) return emitter;

  emitter = new EventEmitter();
  CONTEXT_EMITTER.set(context, emitter);

  const pages = new Set<Page>();
  CONTEXT_PAGE_SET.set(context, pages);

  const attachPage = (page: Page) => {
    if (pages.has(page)) return;
    pages.add(page);

    const emitStatus = (payload: {
      state: "error" | "success",
      reason: string,
      details?: Record<string, unknown>
    }) => {
      emitter!.emit("aluviastatus", payload);
    };

    page.on("domcontentloaded", async () => {
      const html = await page.content();
      const bodyText = await page.evaluate(() => document.body?.innerText || "");
      const title = await page.title();

      const isEmptyBody =
        (await page.evaluate(() => document.body?.children.length || 0)) === 0;

      const onlyLoader =
        await page.evaluate(() => {
          const sel = document.querySelector(".spinner, .loader, [role='progressbar']");
          return !!sel && document.body?.children.length === 1;
        });

      const matchedPatterns: string[] = [];
      for (const rx of FAILURE_PATTERNS) {
        if (rx.test(html) || rx.test(bodyText) || rx.test(title)) {
          matchedPatterns.push(rx.source);
        }
      }

      if (matchedPatterns.length) {
        emitStatus({
          state: "error",
          reason: "content-pattern",
          details: {
            patterns: matchedPatterns,
            title,
            sample: bodyText.slice(0, 500)
          }
        });
        return;
      }

      if (isEmptyBody) {
        emitStatus({
          state: "error",
          reason: "empty-body",
          details: { title }
        });
        return;
      }

      if (onlyLoader) {
        emitStatus({
          state: "error",
          reason: "loader-only",
          details: { title }
        });
        return;
      }
    });
  };

  // Attach existing pages
  for (const p of context.pages()) attachPage(p);
  // Listen for future pages
  context.on("page", attachPage);

  return emitter;
}
