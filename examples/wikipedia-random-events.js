/**
 * Wikipedia Random Article scrape using EventRunner (agentConnectEvents).
 *
 * Demonstrates passive retry handling for navigation/document request failures
 * without wrapping page.goto(). All pages opened within the context are tracked.
 *
 * Prerequisites:
 *   npm install
 *   npx playwright install chromium
 *   export ALUVIA_API_KEY=YOUR_KEY   (Linux/macOS)
 *   setx ALUVIA_API_KEY YOUR_KEY     (Windows PowerShell)
 *
 * Run:
 *   node examples/wikipedia-random-events.js
 *
 * What happens:
 *  - Launches Chromium with a local dynamic proxy (no upstream initially).
 *  - Creates a BrowserContext and attaches EventRunner via agentConnectEvents.
 *  - Navigates to Wikipedia's Special:Random page.
 *  - Extracts the article title, a representative first paragraph, and headings.
 *  - If the initial navigation/network fails with a retryable error pattern,
 *    EventRunner rotates in an upstream proxy and reloads automatically.
 */

import { chromium } from 'playwright';
import { startDynamicProxy, agentConnectEvents, runEventRunnerSelfTest } from '../dist/cjs/src/index.js';

async function main() {
  // Base retry configuration (you can also set env vars ALUVIA_MAX_RETRIES, etc.)
  const RETRY_PATTERNS = ['Timeout', 'net::ERR', 'ECONNRESET', /ETIMEDOUT/];

  // Start local dynamic proxy (upstream will be set only after a failure)
  const dyn = await startDynamicProxy();
  console.log('[dynamic] local proxy started at', dyn.url);

  // Allow overriding headless via env HEADLESS=false
  const headless = process.env.HEADLESS === 'false' ? false : true;
  // Launch browser pointing at local dynamic proxy only (direct upstream initially)
  const browser = await chromium.launch({ headless, proxy: { server: dyn.url } });
  const context = await browser.newContext();

  // Attach event-driven retry logic to the context.
  const runner = agentConnectEvents(context, {
    dynamicProxy: dyn,
    maxRetries: 3,
    backoffMs: 300,
    retryOn: RETRY_PATTERNS,
    onRetry: (attempt, max, lastErr) => {
      console.log(`[event-runner] retry ${attempt}/${max}`, lastErr && (lastErr.message || lastErr));
    },
    onProxyLoaded: (proxy) => {
      console.log('[event-runner] upstream proxy loaded:', proxy.server);
    },
  });

  // Listen for requestfailed events for visibility (EventRunner already listens internally)
  context.on('page', (p) => {
    p.on('requestfailed', (req) => {
      console.log('[page] requestfailed:', req.url(), req.failure()?.errorText);
    });
  });

  const page = await context.newPage();
  const target = 'https://en.wikipedia.org/wiki/Special:Random';

  try {
    console.log('[navigate] Opening random article...');
    await page.goto(target, { waitUntil: 'domcontentloaded' });

    // Ensure main content loaded
    await page.waitForSelector('#mw-content-text');

    const article = await page.evaluate(() => {
      const title = (document.querySelector('#firstHeading') || null)?.textContent?.trim() || null;
      const paragraphs = Array.from(document.querySelectorAll('#mw-content-text p'))
        .map(p => p.textContent?.trim() || '')
        .filter(t => t && t.length > 40);
      const firstParagraph = paragraphs[0] || null;
      const headings = Array.from(document.querySelectorAll('#mw-content-text h2, #mw-content-text h3'))
        .map(h => h.textContent?.replace('[edit]', '').trim())
        .filter(Boolean);
      return { title, firstParagraph, headings, url: location.href };
    });

    console.log('\nRandom Wikipedia Article Summary:\n');
    console.log(JSON.stringify(article, null, 2));
    console.log('\nTracked pages so far:', runner.getTrackedPages().length);
  } catch (err) {
    console.error('[error] Failed to scrape random article:', err);
  } finally {
    console.log('[shutdown] Closing browser & dynamic proxy');
    await browser.close(); // triggers dynamic proxy close via EventRunner context listener
    // dyn.close() is called automatically on context close; calling explicitly is safe
    try { await dyn.close(); } catch {}
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.RUN_SELF_TEST === '1') {
    try {
      const res = runEventRunnerSelfTest();
      console.log('[self-test] EventRunner:', res);
    } catch (e) {
      console.error('[self-test] failed:', e);
    }
  }

  main().catch((e) => { console.error(e); process.exit(1); });
}
