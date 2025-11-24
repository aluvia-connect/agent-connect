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
import { startDynamicProxy, agentConnectListener } from '@aluvia-connect/agent-connect';
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
  });

  const TEST_URL = 'http://10.255.255.1'; // Unroutable (will likely fail / timeout)
  console.log('[nav] Navigating (direct, expect failure):', TEST_URL);
  try {
    await page.goto(TEST_URL, { timeout: 8000 }).catch(err => {
      console.warn('[nav] Initial navigation error (expected):', err.message);
    });
  } catch (err) {
    console.warn('[nav] Navigation threw:', err.message);
  }

  // Wait a bit to allow failed requests + listener to apply upstream
  await new Promise(r => setTimeout(r, 3000));
  console.log('[nav] Current upstream after listener phase:', dynamic.currentUpstream());

  // Second navigation should go through upstream proxy (if applied)
  const SECOND_URL = 'https://example.com';
  console.log('[nav] Navigating again (should use upstream if set):', SECOND_URL);
  try {
    await page.goto(SECOND_URL, { timeout: 15000, waitUntil: 'domcontentloaded' });
    console.log('[nav] Second navigation title:', await page.title());
  } catch (err) {
    console.error('[nav] Second navigation failed:', err.message);
  }

  // Clean up
  await browser.close();
  await dynamic.close();
  console.log('[done] Browser & dynamic proxy closed');
}

main().catch(err => { console.error(err); process.exit(1); });

