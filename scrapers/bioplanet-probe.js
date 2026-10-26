// Bio-Planet probe — zoek promo-pagina en API via Scraping Browser
import { chromium } from "playwright";

export async function probeBioplanet() {
  const sbUser = process.env.BRIGHTDATA_SB_USER;
  const sbPass = process.env.BRIGHTDATA_SB_PASS;
  if (!sbUser || !sbPass) throw new Error("Missing BRIGHTDATA_SB_USER / BRIGHTDATA_SB_PASS");

  const endpointURL = `wss://${sbUser}:${sbPass}@brd.superproxy.io:9222`;
  let browser, ctx, page;

  try {
    browser = await chromium.connectOverCDP(endpointURL);
    ctx = await browser.newContext();
    page = await ctx.newPage();

    // Vang alle XHR/fetch calls op
    const apiCalls = [];
    page.on("request", (req) => {
      const url = req.url();
      if (!url.includes(".css") && !url.includes(".js") && !url.includes(".png") && !url.includes(".woff") && !url.includes("analytics") && !url.includes("dynatrace") && !url.includes("geetest")) {
        apiCalls.push({ type: "request", url: url.slice(0, 200), method: req.method() });
      }
    });
    page.on("response", async (res) => {
      const url = res.url();
      const ct = res.headers()["content-type"] || "";
      if (ct.includes("json") && !url.includes("analytics") && !url.includes("dynatrace")) {
        try {
          const json = await res.json();
          apiCalls.push({ type: "response", url: url.slice(0, 200), keys: Object.keys(json).slice(0, 10) });
        } catch { /* */ }
      }
    });

    await page.goto("https://www.bioplanet.be/nl/promos/alle-promos", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForTimeout(8000);

    console.log("[bioplanet-probe] title:", await page.title());
    console.log("[bioplanet-probe] url:", page.url());
    console.log("[bioplanet-probe] API calls:", JSON.stringify(apiCalls.slice(0, 20)));

    // Dump nav links om juiste URL te vinden
    const navLinks = await page.evaluate(() => {
      return [...document.querySelectorAll("a[href*='promo'], a[href*='actie'], a[href*='aanbieding']")]
        .map(a => ({ text: a.textContent.trim().slice(0, 50), href: a.href }))
        .slice(0, 10);
    });
    console.log("[bioplanet-probe] nav links:", JSON.stringify(navLinks));

    // Dump outerHTML van kaarten met kortingslabel
    const info = await page.evaluate(() => {
      // Vind parent-cards van discount labels
      const labelEls = [...document.querySelectorAll(".card__label-title")];
      const cards = labelEls.map(el => {
        // Ga omhoog tot we een echte card vinden
        let node = el;
        for (let i = 0; i < 8; i++) {
          node = node.parentElement;
          if (!node) break;
          const cls = node.className?.toString() || "";
          if (cls.includes("product") || cls.includes("promo-card") || (cls.includes("card") && !cls.includes("card__"))) {
            return { classes: cls.slice(0, 80), html: node.outerHTML.slice(0, 2000) };
          }
        }
        return { classes: "not-found", html: el.closest("[class]")?.outerHTML?.slice(0, 2000) || "" };
      }).slice(0, 3);

      return { cards };
    });
    console.log("[bioplanet-probe] cards:", JSON.stringify(info.cards));

    return { done: true };
  } finally {
    await page?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await browser?.close();
  }
}
