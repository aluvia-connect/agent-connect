/**
 * Dynamic proxy + listener example.
 *
 * Demonstrates launching Playwright with a local dynamic proxy whose upstream
 * is switched AFTER a failed navigation/request is detected by `agentConnectListener`.
 * The first navigation is attempted DIRECT (no upstream). On the first matching
 * failed request (based on `errorOn` patterns) we fetch an Aluvia proxy and
 * hot-swap it via `dynamic.setUpstream()` without relaunching the browser.
 *
 * Prerequisites:
 *   npm install
 *   npx playwright install
 *   export ALUVIA_TOKEN=YOUR_TOKEN   # or set in your shell/OS
 *
 * Run:
 *   node examples/dynamic-proxy-listener.js
 */
import { chromium } from 'playwright';
//import { startDynamicProxy, agentConnectListener } from '@aluvia-connect/agent-connect';
import { agentConnectListener, startDynamicProxy } from './../dist/esm/src/index.js';
import Aluvia from 'aluvia-ts-sdk';

// Patterns that, when found in request failure errorText, trigger upstream switch
const ERROR_PATTERNS = ['Timeout', 'ETIMEDOUT', 'net::ERR', 'ECONNRESET'];

function newSessionId() { return Math.random().toString(36).slice(2, 10); }

async function fetchAluviaProxy() {
  const apiKey = process.env.ALUVIA_TOKEN || '';
  if (!apiKey) throw new Error('Missing ALUVIA_TOKEN environment variable');
  const client = new Aluvia(apiKey);
  const proxy = await client.first();
  if (!proxy) throw new Error('No proxy available from Aluvia');
  const sessionId = newSessionId();
  return {
    server: `http://${proxy.host}:${proxy.httpPort}`,
    username: `${proxy.username}-session-${sessionId}`,
    password: proxy.password,
  };
}

async function main() {
  const dynamic = await startDynamicProxy();
  console.log('[dynamic] Local proxy listening at', dynamic.url);

  // Launch browser pointing at local dynamic proxy (initially direct)
  const browser = await chromium.launch({ headless: false, proxy: { server: dynamic.url } });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Attach listener that will switch upstream on first qualifying failed request
  let upstreamSet = false;
  // Buffer the latest status and resolve any pending waiter
  let lastStatus = null;
  let pendingResolve = null;
  const emitter = agentConnectListener(context, { errorOn: ERROR_PATTERNS });
  emitter.on('aluviastatus', async (payload) => {
    if (payload.state === 'error' && !upstreamSet) {
      upstreamSet = true; // ensure only first error triggers swap (adjust as needed)
      console.log('[listener] Detected failed request matching patterns. Switching upstream proxy...');
      try {
        const upstream = await fetchAluviaProxy();
        await dynamic.setUpstream(upstream);
        console.log('[listener] Upstream proxy applied:', upstream.server);
      } catch (err) {
        console.error('[listener] Failed to fetch/apply upstream proxy:', err.message || err);
      }
    } else if (payload.state === 'success') {
      console.log('[listener] Page load success');
    }
    // buffer and resolve any waiter
    lastStatus = payload;
    if (pendingResolve) {
      pendingResolve(payload);
      pendingResolve = null;
    }
  });

  // Helper: wait for the next aluviastatus event (error or success)
  function waitForStatus() {
    // immediate if already buffered
    if (lastStatus) return Promise.resolve(lastStatus);

    return Promise.race([
      new Promise(resolve => {
        emitter.once('aluviastatus', resolve);
      }),
      new Promise((resolve, reject) => {
        setTimeout(() => {
          resolve('TimeoutError: Timeout 10000ms exceeded.');
        }, 30000)
      })
    ]);
  }

  //const TARGET_URL = 'https://www.aluvia.io/'; // Unroutable (expected to trigger errors first)
  //const TARGET_URL = 'https://denniskrol.nl/'; // Unroutable (expected to trigger errors first)
  const TARGET_URL = 'https://2captcha.com/demo/cloudflare-turnstile-challenge'; // Unroutable (expected to trigger errors first)
  const MAX_ATTEMPTS = 5;
  let attempt = 0;
  let succeeded = false;

  while (attempt < MAX_ATTEMPTS && !succeeded) {
    attempt++;
    console.log(`\n[loop] Attempt ${attempt}/${MAX_ATTEMPTS} navigating to ${TARGET_URL}`);
    // reset buffer so we only consider events for this attempt
    lastStatus = null;
    try {
      await page.goto(TARGET_URL, { timeout: 30000 }).catch(err => {
        console.warn('[nav] page.goto threw (continuing to wait for status):', err.message);
      });
    } catch (err) {
      console.warn('[nav] Navigation outer try threw:', err.message);
    }

    // Wait for first status event (either request error or load success)
    const status = await waitForStatus();
    if (status.state === 'error') {
      console.log(`[loop] Error status received: ${status.reason} (${status.details.patterns}). Reloading page...`);
      try {
        await page.reload({ timeout: 30000 });
        // After reload we still must wait for a success event; continue loop.
        continue;
      } catch (err) {
        console.warn('[loop] page.reload failed:', err.message);
      }
    }
    succeeded = true;
  }

  console.log('[loop] Finished with succeeded =', succeeded, ' current upstream =', dynamic.currentUpstream());

  // Wait 30 seconds so we can show the page
  if (succeeded) {
    console.log('[done] Navigation succeeded, waiting 30 seconds before cleanup...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    }

  // Clean up
  await browser.close();
  await dynamic.close();
  console.log('[done] Browser & dynamic proxy closed');
  process.exit();
}

main().catch(err => { console.error(err); process.exit(1); });
