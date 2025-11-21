import type { BrowserContext, Page, Request } from "playwright";
import { EventEmitter } from "events";

// Added WeakMaps to manage per-context emitters and page sets
const CONTEXT_EMITTER = new WeakMap<BrowserContext, EventEmitter>();
const CONTEXT_PAGE_SET = new WeakMap<BrowserContext, Set<Page>>();

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
    page.on("requestfailed", (request: Request) => {
      const errorText = request.failure()?.errorText || "";
      if (errorOn.some(pattern => errorText.includes(pattern))) {
        emitter!.emit("aluviaError", request);
      }
    });
  };

  // Attach existing pages
  for (const p of context.pages()) attachPage(p);
  // Listen for future pages
  context.on("page", attachPage);

  return emitter;
}
