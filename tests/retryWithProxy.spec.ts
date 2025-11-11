import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as playwrightMocks from "./__mocks__/playwright";
import * as aluviaMocks from "./__mocks__/aluvia-ts-sdk";

// Mocks must be declared before importing the module under test (src/index.ts)
vi.mock("playwright", () => ({
  chromium: playwrightMocks.chromium,
  firefox: playwrightMocks.firefox,
  webkit: playwrightMocks.webkit,
}));

vi.mock("aluvia-ts-sdk", () => ({
  default: aluviaMocks.default,
}));

vi.mock("proxy-chain", () => ({
  Server: class MockProxyChainServer {
    server = { address() { return { port: 5555 }; } } as any;
    async listen() {}
    async close() {}
    constructor(_opts?: any) {}
  }
}));

// Import after mocks
import { agentConnect, startDynamicProxy } from "../src";
import { FakeBrowser, FakePage, __setOnLaunch } from "./__mocks__/playwright";

const DATA_OK = "data:text/html,<title>ok</title>ok";

async function makeBrowserAndPage() {
  const b = new FakeBrowser("chromium");
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  return { browser: b, page: p };
}

describe("agentConnect (mocked Playwright)", () => {
  let browser: FakeBrowser;
  let page: FakePage;

  beforeEach(async () => {
    process.env.ALUVIA_API_KEY = "TEST";
    process.env.ALUVIA_RETRY_ON = "ETIMEDOUT,Timeout,net::ERR";

    // Each relaunch in SDK will get a new fake browser
    __setOnLaunch((type) => new FakeBrowser(type));

    const made = await makeBrowserAndPage();
    browser = made.browser;
    page = made.page;
  });

  afterEach(() => {
    __setOnLaunch(null as any);
  });

  it("uses custom proxyProvider if provided", async () => {
    const dyn = await startDynamicProxy();
    let called = false;
    const customProxyProvider = {
      async get() {
        called = true;
        return {
          server: "http://custom-proxy:1234",
          username: "customuser",
          password: "custompass",
        };
      },
    };

    // Force first goto to fail once with Timeout
    let failed = false;
    page.__setGoto(async () => {
      if (!failed) {
        failed = true;
        throw new Error("Timeout");
      }
      return null; // success on retry
    });

    const { page: p2 } = await agentConnect(page as any, {
      dynamicProxy: dyn,
      maxRetries: 1,
      backoffMs: 1,
      proxyProvider: customProxyProvider,
      retryOn: ["Timeout", "ETIMEDOUT", /net::ERR/],
    }).goto(DATA_OK);

    expect(called).toBe(true);
    expect(await p2.title()).toBe("ok");
  });

  it("succeeds without retry on first attempt", async () => {
    const dyn = await startDynamicProxy();
    page.__setGoto(async () => null); // immediate success

    const { response, page: p2 } = await agentConnect(page as any).goto(
      DATA_OK
    );

    expect(response).toBeNull();
    expect(p2).toBe(page as any);
    expect(await p2.title()).toBe("ok");
  });

  it("dynamicProxy switches upstream without relaunch", async () => {
    const dyn = await startDynamicProxy();

    // Force first failure
    let calls = 0;
    page.__setGoto(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("Timeout"), { code: "Timeout" });
      return null;
    });

    const { page: same } = await agentConnect(page as any, {
      dynamicProxy: dyn,
      maxRetries: 2,
      backoffMs: 1,
      retryOn: ["Timeout"],
    }).goto(DATA_OK);

    // Should reuse original page instance
    expect(same).toBe(page as any);
    expect(await same.title()).toBe("ok");
    await dyn.close();
  });

  it("dynamicProxy does not retry on non-retryable error", async () => {
    const dyn = await startDynamicProxy();
    page.__setGoto(async () => { throw new Error("NonRetryable") });
    await expect(
      agentConnect(page as any, { dynamicProxy: dyn, retryOn: ["Timeout"], maxRetries: 2 }).goto(DATA_OK)
    ).rejects.toThrow();
    await dyn.close();
  });

  it("dynamicProxy performs multiple attempts on retryable errors", async () => {
    const dyn = await startDynamicProxy();
    let attempts = 0;
    page.__setGoto(async () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("Timeout"), { code: "Timeout" });
      return null;
    });
    const { page: same } = await agentConnect(page as any, { dynamicProxy: dyn, retryOn: ["Timeout"], maxRetries: 5, backoffMs: 0 }).goto(DATA_OK);
    expect(attempts).toBe(3); // first + two retries
    expect(same).toBe(page as any);
    await dyn.close();
  });

  it("dynamicProxy respects maxRetries", async () => {
    const dyn = await startDynamicProxy();
    page.__setGoto(async () => { throw Object.assign(new Error("Timeout"), { code: "Timeout" }); });
    await expect(
      agentConnect(page as any, { dynamicProxy: dyn, retryOn: ["Timeout"], maxRetries: 0 }).goto(DATA_OK)
    ).rejects.toThrow();
    await dyn.close();
  });

  it("dynamicProxy assigns a different upstream username each retry", async () => {
    const dyn = await startDynamicProxy();
    let gotoCalls = 0;
    // Fail first 2 retries, succeed on 3rd navigation attempt inside dynamic proxy loop
    page.__setGoto(async () => {
      gotoCalls++;
      if (gotoCalls < 3) throw Object.assign(new Error("Timeout"), { code: "Timeout" });
      return null;
    });

    let providerCalls = 0;
    const rotatingProvider = {
      async get() {
        providerCalls++;
        return {
          server: "http://rotating-proxy:1000",
          username: `user-${providerCalls}`,
          password: "pw",
        };
      },
    };

    const usernames: string[] = [];

    const { page: same } = await agentConnect(page as any, {
      dynamicProxy: dyn,
      maxRetries: 5,
      backoffMs: 0,
      retryOn: ["Timeout"],
      proxyProvider: rotatingProvider as any,
      onProxyLoaded: (p) => { if (p.username) usernames.push(p.username); },
    }).goto(DATA_OK);

    expect(same).toBe(page as any);
    expect(usernames.length).toBeGreaterThan(1); // multiple retries occurred
    expect(new Set(usernames).size).toBe(usernames.length); // all unique
    await dyn.close();
  });
});
