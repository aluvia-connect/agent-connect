import { vi } from "vitest";

type BrowserTypeName = "chromium" | "firefox" | "webkit";
type GotoFn = (url: string, opts?: any) => Promise<any>;

export class FakePage {
  private _title = "ok";
  private _gotoImpl: GotoFn;
  private _ctx: FakeContext;
  private _events: Record<string, Function[]> = {};
  private _lastUrl: string | undefined;
  private _reloadImpl: (opts?: any) => Promise<any> = async (opts?: any) => {
    if (!this._lastUrl) return null;
    return this._gotoImpl(this._lastUrl, opts);
  };

  constructor(ctx: FakeContext, gotoImpl?: GotoFn) {
    this._ctx = ctx;
    this._gotoImpl = gotoImpl ?? (async () => null); // mimic data: URL -> null Response
  }

  on(event: string, cb: Function) {
    (this._events[event] ||= []).push(cb);
  }

  async goto(url: string, opts?: any) {
    this._lastUrl = url;
    return this._gotoImpl(url, opts);
  }

  async reload(opts?: any) {
    return this._reloadImpl(opts);
  }

  __setReload(fn: (opts?: any) => Promise<any>) {
    this._reloadImpl = fn;
  }

  async title() {
    return this._title;
  }

  context() {
    return this._ctx;
  }

  async close() {}

  /** Test helper: override goto behavior */
  __setGoto(fn: GotoFn) {
    this._gotoImpl = fn;
  }

  /** Test helper: simulate a requestfailed event */
  __emitRequestFailed(
    errorText: string,
    url: string = this._lastUrl || "http://example.com",
    resourceType: string = "document"
  ) {
    const req = {
      url: () => url,
      resourceType: () => resourceType,
      failure: () => ({ errorText }),
    };
    (this._events["requestfailed"] || []).forEach((fn) => {
      try {
        fn(req);
      } catch {}
    });
  }
}

export class FakeContext {
  private _browser: FakeBrowser;
  private _pages: FakePage[] = [];
  private _events: Record<string, Function[]> = {};

  constructor(browser: FakeBrowser) {
    this._browser = browser;
  }

  async newPage() {
    const p = new FakePage(this);
    this._pages.push(p);
    // Emit 'page' event to listeners
    (this._events["page"] || []).forEach((fn) => {
      try {
        fn(p);
      } catch {}
    });
    return p;
  }

  pages() {
    return this._pages;
  }

  browser() {
    return this._browser;
  }

  on(event: string, cb: Function) {
    (this._events[event] ||= []).push(cb);
  }

  async close() {
    (this._events["close"] || []).forEach((fn) => {
      try {
        fn({});
      } catch {}
    });
  }

  // Optional fields some SDKs read
  _options = {
    userAgent: "fake-UA",
    viewport: { width: 1280, height: 720 },
    storageState: undefined as any,
  };
}

export class FakeBrowser {
  private _type: BrowserTypeName;
  private _contexts: FakeContext[] = [];
  private _closed = false;

  constructor(type: BrowserTypeName = "chromium") {
    this._type = type;
  }

  async newContext() {
    const ctx = new FakeContext(this);
    this._contexts.push(ctx);
    return ctx;
  }

  contexts() {
    return this._contexts;
  }

  async close() {
    this._closed = true;
  }

  isClosed() {
    return this._closed;
  }

  /** return a BrowserType *object* with .launch() */
  browserType() {
    switch (this._type) {
      case "chromium":
        return chromium;
      case "firefox":
        return firefox;
      case "webkit":
        return webkit;
      default:
        return chromium;
    }
  }

  __type() {
    return this._type;
  }
}

let onLaunch: ((type: BrowserTypeName) => FakeBrowser) | null = null;

/** Allow tests to control what launch() returns */
export function __setOnLaunch(
  fn: ((type: BrowserTypeName) => FakeBrowser) | null
) {
  onLaunch = fn;
}

const make = (type: BrowserTypeName) => ({
  launch: vi.fn(async () =>
    onLaunch ? onLaunch(type) : new FakeBrowser(type)
  ),
});

export const chromium = make("chromium");
export const firefox = make("firefox");
export const webkit = make("webkit");

export default { chromium, firefox, webkit };
