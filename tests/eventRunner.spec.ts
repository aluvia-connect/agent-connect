import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as playwrightMocks from './__mocks__/playwright';
import * as aluviaMocks from './__mocks__/aluvia-ts-sdk';

vi.mock('playwright', () => ({
  chromium: playwrightMocks.chromium,
  firefox: playwrightMocks.firefox,
  webkit: playwrightMocks.webkit,
}));

vi.mock('aluvia-ts-sdk', () => ({
  default: aluviaMocks.default,
}));

vi.mock('proxy-chain', () => ({
  Server: class MockProxyChainServer { server = { address() { return { port: 5555 }; } } as any; async listen() {} async close() {} constructor(_opts?: any) {} }
}));

import { startDynamicProxy, agentConnectEvents } from '../src';
import { FakeBrowser, __setOnLaunch } from './__mocks__/playwright';

const DATA_URL = 'http://example.com';

async function makeBrowserContextAndPage() {
  const b = new FakeBrowser('chromium');
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  return { browser: b, context: ctx, page: p };
}

describe('EventRunner (requestfailed based retries)', () => {
  beforeEach(() => {
    process.env.ALUVIA_API_KEY = 'TEST';
    process.env.ALUVIA_RETRY_ON = 'Timeout,ETIMEDOUT';
    __setOnLaunch((type) => new FakeBrowser(type));
  });

  it('closes dynamic proxy when context closes', async () => {
    const { context } = await makeBrowserContextAndPage();
    const dyn = await startDynamicProxy();
    const closeSpy = vi.spyOn(dyn, 'close');
    agentConnectEvents(context as any, { dynamicProxy: dyn });
    await context.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('tracks existing pages and new pages', async () => {
    const { context, page } = await makeBrowserContextAndPage();
    const dyn = await startDynamicProxy();
    const runner = agentConnectEvents(context as any, { dynamicProxy: dyn });
    expect(runner.getTrackedPages().includes(page as any)).toBe(true);
    const newPage = await context.newPage();
    expect(runner.getTrackedPages().includes(newPage as any)).toBe(true);
  });

  it('retries failed navigation request (document resource)', async () => {
    const { context, page } = await makeBrowserContextAndPage();
    let calls = 0;
    page.__setGoto(async () => {
      calls++;
      if (calls === 1) return null; // initial successful navigation
      if (calls < 4) throw Object.assign(new Error('Timeout'), { code: 'Timeout' }); // two failing reloads
      return null; // success after retries
    });
    const dyn = await startDynamicProxy();
    const proxyProvider = { async get() { return { server: 'http://proxy:1000', username: 'u', password: 'p' }; } };
    agentConnectEvents(context as any, { dynamicProxy: dyn, maxRetries: 5, backoffMs: 0, proxyProvider, retryOn: ['Timeout'] });
    await page.goto(DATA_URL); // initial success
    (page as any).__emitRequestFailed('Timeout', DATA_URL, 'document');
    // wait for retries to complete
    for (let i = 0; i < 20 && calls < 4; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    expect(calls).toBe(4); // initial + 2 failures + final success
    await dyn.close();
  });

  it('does not retry non-document failures', async () => {
    const { context, page } = await makeBrowserContextAndPage();
    let calls = 0;
    page.__setGoto(async () => { calls++; return null; });
    const dyn = await startDynamicProxy();
    agentConnectEvents(context as any, { dynamicProxy: dyn, maxRetries: 2, backoffMs: 0, retryOn: ['Timeout'] });
    await page.goto(DATA_URL);
    (page as any).__emitRequestFailed('Timeout', DATA_URL, 'image'); // ignored
    expect(calls).toBe(1);
    await dyn.close();
  });

  it('does not retry if error not matching patterns', async () => {
    const { context, page } = await makeBrowserContextAndPage();
    let calls = 0;
    page.__setGoto(async () => { calls++; return null; });
    const dyn = await startDynamicProxy();
    agentConnectEvents(context as any, { dynamicProxy: dyn, maxRetries: 3, backoffMs: 0, retryOn: ['Timeout'] });
    await page.goto(DATA_URL);
    (page as any).__emitRequestFailed('NonRetryable', DATA_URL, 'document');
    expect(calls).toBe(1);
    await dyn.close();
  });
});
