import { describe, it, expect, vi } from "vitest";
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

import { listen } from '../src';
import { EventEmitter } from 'events';

describe('listen', () => {
  it('should emit aluviaError when a page emits requestfailed', () => {
    // Mock Page and BrowserContext
    const pageEmitter = new EventEmitter();
    const page = Object.assign(pageEmitter, {
      on: pageEmitter.on.bind(pageEmitter),
    });

    const contextEmitter = new EventEmitter();
    const context = Object.assign(contextEmitter, {
      pages: () => [page],
      on: contextEmitter.on.bind(contextEmitter),
    });

    const emitter = listen(context as any);

    const mockRequest = { url: 'http://example.com' };
    const handler = vi.fn();

    emitter.on('aluviaError', handler);

    // Simulate requestfailed event
    pageEmitter.emit('requestfailed', mockRequest);

    expect(handler).toHaveBeenCalledWith(mockRequest);
  });
});
