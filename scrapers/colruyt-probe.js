// Colruyt website probe — discover what APIs colruyt.be/nl/acties uses internally
// Run via: POST /colruyt-probe (Railway)
import { chromium } from "playwright";

export async function probeColruyt() {
  const sbUser = process.env.BRIGHTDATA_SB_USER;
  const sbPass = process.env.BRIGHTDATA_SB_PASS;
  if (!sbUser || !sbPass) throw new Error("Missing BRIGHTDATA_SB_USER / BRIGHTDATA_SB_PASS");

  const endpointURL = `wss://${sbUser}:${sbPass}@brd.superproxy.io:9222`;
  let browser, ctx, page;

  const apiCalls = [];
  const jsonResponses = [];
  const pageInfo = {};

  try {
    browser = await chromium.connectOverCDP(endpointURL);
    ctx = await browser.newContext();
    page = await ctx.newPage();

    // Intercept ALL requests to discover API patterns
    page.on("request", (req) => {
      const url = req.url();
      // Skip static assets
      if (/\.(png|jpg|jpeg|gif|svg|css|woff|woff2|ttf|ico)(\?|$)/i.test(url)) return;
      if (url.includes("google") || url.includes("facebook") || url.includes("analytics") || url.includes("cookie") || url.includes("consent")) return;
      apiCalls.push({
        method: req.method(),
        url: url.slice(0, 250),
        type: req.resourceType(),
        headers: url.includes("colruyt") ? Object.fromEntries(
          Object.entries(req.headers()).filter(([k]) => /auth|token|cookie|x-|api/i.test(k))
        ) : undefined,
      });
    });

    // Intercept JSON responses
    page.on("response", async (res) => {
      const url = res.url();
      const ct = res.headers()["content-type"] || "";
      if (!ct.includes("json") && !ct.includes("graphql")) return;
      try {
        const json = await res.json();
        const preview = JSON.stringify(json).slice(0, 500);
        jsonResponses.push({
          url: url.slice(0, 250),
          status: res.status(),
          keys: typeof json === "object" ? Object.keys(json).slice(0, 20) : [],
          hasProducts: !!(json?.products || json?.items || json?.data?.products || json?.results),
          productCount: (json?.products || json?.items || json?.data?.products || json?.results || []).length || 0,
          totalAvailable: json?.productsAvailable || json?.totalProducts || json?.total || json?.totalCount || null,
          preview,
        });
      } catch { /* ignore non-JSON */ }
    });

    // Navigate to promo page
    console.log("[colruyt-probe] Loading colruyt.be/nl/acties...");
    await page.goto("https://www.colruyt.be/nl/acties", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForTimeout(10000);

    pageInfo.title = await page.title().catch(() => "unknown");
    pageInfo.url = page.url();
    pageInfo.status = "loaded";

    // Extract visible promo info from page
    const promoData = await page.evaluate(() => {
      const results = {
        promoCards: 0,
        sampleCards: [],
        promoLabels: [],
        links: [],
        iframes: document.querySelectorAll("iframe").length,
        scripts: [],
      };

      // Look for promo cards/tiles
      const selectors = [
        "[data-testid*='promo']", "[data-testid*='product']", "[data-testid*='deal']",
        ".promo-card", ".promo-tile", ".promotion", ".deal-card", ".product-card",
        "[class*='promo']", "[class*='promotion']", "[class*='deal']", "[class*='action']",
        ".action-card", ".folder-card", ".actie",
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          results.promoCards += els.length;
          results.sampleCards.push({
            selector: sel,
            count: els.length,
            firstHTML: els[0].outerHTML.slice(0, 500),
            firstText: els[0].textContent?.trim()?.slice(0, 200),
          });
        }
      }

      // Look for discount labels
      const labelSelectors = [
        "[class*='discount']", "[class*='korting']", "[class*='saving']",
        "[class*='percentage']", "[class*='badge']", "[class*='sticker']",
        "[class*='promo-tag']", "[class*='price-old']", "[class*='was-price']",
        "[class*='old-price']", "[class*='original-price']",
      ];
      for (const sel of labelSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          results.promoLabels.push({
            selector: sel,
            count: els.length,
            samples: Array.from(els).slice(0, 3).map(e => e.textContent?.trim()?.slice(0, 100)),
          });
        }
      }

      // Interesting links on the page
      const anchors = document.querySelectorAll("a[href*='actie'], a[href*='promo'], a[href*='folder']");
      results.links = Array.from(anchors).slice(0, 10).map(a => ({
        href: a.href,
        text: a.textContent?.trim()?.slice(0, 80),
      }));

      // Check for Next.js / React data
      const nextData = document.querySelector("#__NEXT_DATA__");
      if (nextData) {
        try {
          const parsed = JSON.parse(nextData.textContent);
          results.nextData = {
            keys: Object.keys(parsed?.props?.pageProps || {}),
            hasPromotions: JSON.stringify(parsed).includes("promo"),
          };
        } catch {}
      }

      // Inline script data
      const scriptEls = document.querySelectorAll("script:not([src])");
      for (const s of Array.from(scriptEls).slice(0, 20)) {
        const text = s.textContent || "";
        if (text.includes("promo") || text.includes("product") || text.includes("price") || text.includes("actie")) {
          results.scripts.push(text.slice(0, 300));
        }
      }

      // Full page text sample for structure analysis
      results.bodyTextSample = document.body?.innerText?.slice(0, 2000);

      return results;
    });

    // Try scrolling to trigger lazy-load APIs
    console.log("[colruyt-probe] Scrolling to trigger lazy loads...");
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(2000);
    }

    // Also try navigating to a specific promo subcategory
    const _subpageAPIs = [];
    try {
      const promoLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a"))
          .filter(a => /actie|promo|folder/i.test(a.href) && a.href !== window.location.href)
          .slice(0, 3)
          .map(a => a.href);
      });
      pageInfo.promoSubLinks = promoLinks;
    } catch {}

    return {
      pageInfo,
      apiCallCount: apiCalls.length,
      colruytAPIs: apiCalls.filter(c => c.url.includes("colruyt")),
      jsonResponses,
      promoData,
    };
  } finally {
    await page?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await browser?.close();
  }
}
