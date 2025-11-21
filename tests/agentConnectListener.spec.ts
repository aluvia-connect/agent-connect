import { describe, it, expect, vi } from "vitest";
import * as playwrightMocks from "./__mocks__/playwright";

vi.mock("playwright", () => ({
  chromium: playwrightMocks.chromium,
  firefox: playwrightMocks.firefox,
  webkit: playwrightMocks.webkit,
}));

import { agentConnectListener } from "../src/listener";
import { EventEmitter } from "events";

describe("agentConnectListener (errorOn filtering)", () => {
  function makeContextWithSinglePage(pageEmitter: EventEmitter) {
    const page = Object.assign(pageEmitter, {
      on: pageEmitter.on.bind(pageEmitter),
    });
    const contextEmitter = new EventEmitter();
    return Object.assign(contextEmitter, {
      pages: () => [page],
      on: contextEmitter.on.bind(contextEmitter),
    });
  }

  it("emits only for errors listed in errorOn", () => {
    const pageEmitter = new EventEmitter();
    const context = makeContextWithSinglePage(pageEmitter);

    const emitter = agentConnectListener(context as any, {
      errorOn: ["TimeoutError"],
    });

    const handler = vi.fn();
    emitter.on("aluviaError", handler);

    const timeoutRequest = {
      url: "http://example.com/timeout",
      failure: () => ({ errorText: "TimeoutError" }),
    };
    const dnsRequest = {
      url: "http://example.com/dns",
      failure: () => ({ errorText: "DNSResolveError" }),
    };

    pageEmitter.emit("requestfailed", timeoutRequest);
    pageEmitter.emit("requestfailed", dnsRequest);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(timeoutRequest);
  });

  it("emits for multiple configured error types", () => {
    const pageEmitter = new EventEmitter();
    const context = makeContextWithSinglePage(pageEmitter);

    const emitter = agentConnectListener(context as any, {
      errorOn: ["TimeoutError", "ConnectionRefused"],
    });

    const handler = vi.fn();
    emitter.on("aluviaError", handler);

    const timeoutRequest = {
      url: "http://example.com/timeout",
      failure: () => ({ errorText: "TimeoutError" }),
    };
    const connRefusedRequest = {
      url: "http://example.com/conn",
      failure: () => ({ errorText: "ConnectionRefused" }),
    };
    const otherRequest = {
      url: "http://example.com/other",
      failure: () => ({ errorText: "TLSHandshakeError" }),
    };

    pageEmitter.emit("requestfailed", timeoutRequest);
    pageEmitter.emit("requestfailed", connRefusedRequest);
    pageEmitter.emit("requestfailed", otherRequest);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, timeoutRequest);
    expect(handler).toHaveBeenNthCalledWith(2, connRefusedRequest);
  });
});
