// Store location scrapers per chain
import { chromium } from "playwright";

const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
function dedup(stores) {
  const seen = new Set();
  return stores.filter(s => { const k = `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
function store(lat, lon, name, city, street, postcode) {
  return { lat: r6(lat), lon: r6(lon), name: name || "", city: city || "", street: street || "", housenumber: "", postcode: postcode || "" };
}

async function withBrightdata(fn) {
  const sbUser = process.env.BRIGHTDATA_SB_USER;
  const sbPass = process.env.BRIGHTDATA_SB_PASS;
  if (!sbUser || !sbPass) throw new Error("Missing BRIGHTDATA_SB creds");
  let browser, ctx, page;
  try {
    browser = await chromium.connectOverCDP(`wss://${sbUser}:${sbPass}@brd.superproxy.io:9222`);
    ctx = await browser.newContext();
    page = await ctx.newPage();
    return await fn(page);
  } finally {
    try { await page?.close(); } catch {}
    try { await ctx?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

// ---- Bon'Ap (plain HTML) ----
async function fetchBonapStores() {
  const res = await fetch("https://www.bonap.be/nl/winkels", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const html = await res.text();
  const stores = [];
  for (const m of html.matchAll(/<h3[^>]*>([^<]+)<\/h3>[\s\S]*?destination=(5[01]\.\d+),([\d.]+)/g)) {
    stores.push(store(m[2], m[3], m[1].trim()));
  }
  if (!stores.length) for (const m of html.matchAll(/destination=(5[01]\.\d+),([\d.]+)/g)) stores.push(store(m[1], m[2], "Bon'Ap"));
  return dedup(stores);
}

// ---- Hubo (Woosmap API) ----
async function fetchHuboStores() {
  const stores = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.woosmap.com/stores/search?stores_by_page=300&page=${page}&key=woos-b9634646-c30b-3355-8f90-34752e0cbdd0`, {
      headers: { Referer: "https://www.hubo.be/", Origin: "https://www.hubo.be" },
    });
    if (!res.ok) break;
    const json = await res.json();
    for (const f of json.features || []) {
      const [lon, lat] = f.geometry?.coordinates || [];
      if (!lat || lat < 49 || lat > 52) continue;
      const p = f.properties || {};
      stores.push(store(lat, lon, p.name || "Hubo", p.address?.city, p.address?.lines?.[0], p.address?.zipcode));
    }
    if ((json.features || []).length < 300) break;
  }
  return dedup(stores);
}

// ---- Action (Brightdata - extract from Next.js SSR HTML) ----
async function fetchActionStores() {
  return withBrightdata(async (page) => {
    const intercepted = [];
    page.on("response", async (res) => {
      try {
        if (!(res.headers()["content-type"] || "").includes("json")) return;
        const json = await res.json();
        const arr = json.stores || json.results || json.data || (Array.isArray(json) ? json : null);
        if (!arr || arr.length < 5) return;
        for (const s of arr) {
          const lat = Number(s.latitude || s.lat); const lon = Number(s.longitude || s.lng);
          if (lat > 49 && lat < 52) intercepted.push(store(lat, lon, s.name || s.storeName || "Action", s.city, s.street || s.address, s.zipCode || s.postalCode));
        }
      } catch {}
    });
    await page.goto("https://www.action.com/nl-be/winkels/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(5000);
    if (intercepted.length > 0) return dedup(intercepted);
    // Fallback: parse rendered HTML
    const stores = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const results = [];
      // Next.js stores data in script chunks; coords appear as "latitude":XX.XX,"longitude":X.XX
      // Also try: lat property in JSON-like structures
      for (const m of html.matchAll(/"latitude":\s*(5[01]\.\d{3,})\s*,\s*"longitude":\s*(\d\.\d{3,})/g)) {
        results.push({ lat: Number(m[1]), lon: Number(m[2]) });
      }
      // Escaped Next.js format: \\\"latitude\\\":50.xxx
      if (!results.length) {
        for (const m of html.matchAll(/\\"latitude\\":\s*(5[01]\.\d{3,})\s*,\s*\\"longitude\\":\s*(\d\.\d{3,})/g)) {
          results.push({ lat: Number(m[1]), lon: Number(m[2]) });
        }
      }
      return results;
    });
    return dedup(stores.map(s => store(s.lat, s.lon, "Action")));
  });
}

// ---- Colruyt Group (Brightdata - intercept places API with session) ----
async function fetchColruytGroupStores(brand, siteUrl, chainName) {
  return withBrightdata(async (page) => {
    const intercepted = [];
    page.on("response", async (res) => {
      try {
        const url = res.url();
        if (!url.includes("cgplacesretrsvcv4") && !url.includes("places")) return;
        const json = await res.json();
        // Single store detail
        if (json.latitude && json.longitude) {
          intercepted.push(store(json.latitude, json.longitude, json.name || chainName, json.municipality || json.city, json.street, json.zipCode));
        }
        // Array of stores
        for (const s of (json.stores || json.results || json.places || [])) {
          if (s.latitude && s.longitude) intercepted.push(store(s.latitude, s.longitude, s.name || chainName, s.municipality, s.street, s.zipCode));
        }
      } catch {}
    });
    // Visit homepage to get session, then navigate to store selector
    await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);
    // Click store selector to trigger API call
    try {
      const sel = await page.$('.store-selector, [class*="store-selector"], [data-component="store-selector"], button[class*="store"]');
      if (sel) { await sel.click(); await page.waitForTimeout(3000); }
    } catch {}
    // The initial page load gets 1 store. We need more.
    // Try searching for stores by entering postcodes in different regions
    const postcodes = ["1000","2000","3000","4000","5000","6000","7000","8000","9000"];
    for (const pc of postcodes) {
      try {
        const input = await page.$('input[type="text"][placeholder*="zoek"], input[type="text"][placeholder*="postcode"], input[name*="search"], input[id*="store-search"]');
        if (input) {
          await input.fill(pc);
          await page.keyboard.press("Enter");
          await page.waitForTimeout(2000);
        } else break;
      } catch { break; }
    }
    return dedup(intercepted);
  });
}

// ---- Carrefour (Brightdata - find stores.json URL) ----
async function fetchCarrefourStores() {
  return withBrightdata(async (page) => {
    const stores = [];
    page.on("response", async (res) => {
      try {
        const _url = res.url();
        const ct = res.headers()["content-type"] || "";
        if (!ct.includes("json")) return;
        const json = await res.json();
        const arr = json.stores || (Array.isArray(json) ? json : null);
        if (!arr || arr.length < 10) return;
        for (const s of arr) {
          const lat = Number(s.latitude || s.lat); const lon = Number(s.longitude || s.lng);
          if (lat > 49 && lat < 52) stores.push(store(lat, lon, s.name || "Carrefour", s.city, s.address1 || s.street, s.postalCode));
        }
      } catch {}
    });
    // Try multiple store locator URLs
    for (const url of ["https://www.carrefour.be/nl/onze-winkels", "https://www.carrefour.be/nl/storelocator", "https://www.carrefour.be/nl/nos-magasins"]) {
      if (stores.length > 10) break;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForTimeout(4000);
      } catch {}
    }
    // Fallback: search the page for a stores.json link and fetch it
    if (stores.length === 0) {
      const storeJsonUrl = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll("script")];
        for (const s of scripts) {
          const m = s.src?.match(/store/i) || s.textContent?.match(/(\/on\/demandware[^"']*stores\.json[^"']*)/);
          if (m) return m[1] || m[0];
        }
        return null;
      });
      if (storeJsonUrl) {
        try {
          const fullUrl = storeJsonUrl.startsWith("http") ? storeJsonUrl : "https://www.carrefour.be" + storeJsonUrl;
          const r = await page.evaluate(async (url) => {
            const res = await fetch(url);
            return res.json();
          }, fullUrl);
          for (const s of (r.stores || r || [])) {
            const lat = Number(s.latitude || s.lat); const lon = Number(s.longitude || s.lng);
            if (lat > 49 && lat < 52) stores.push(store(lat, lon, s.name || "Carrefour", s.city, s.address1, s.postalCode));
          }
        } catch {}
      }
    }
    return dedup(stores);
  });
}

// ---- Aldi (Brightdata - find store data) ----
async function fetchAldiStores() {
  return withBrightdata(async (page) => {
    const stores = [];
    page.on("response", async (res) => {
      try {
        const ct = res.headers()["content-type"] || "";
        if (!ct.includes("json")) return;
        const json = await res.json();
        const arr = json.stores || json.results || json.data || json.items || (Array.isArray(json) ? json : null);
        if (!arr || arr.length < 3) return;
        for (const s of arr) {
          const lat = Number(s.latitude || s.lat || s.geopoint?.latitude);
          const lon = Number(s.longitude || s.lng || s.geopoint?.longitude);
          if (lat > 49 && lat < 52) stores.push(store(lat, lon, s.name || "Aldi", s.city, s.street, s.zip || s.postalCode));
        }
      } catch {}
    });
    // Aldi.be main page -> look for store finder
    await page.goto("https://www.aldi.be/nl.html", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);
    // Find store finder link and navigate
    const href = await page.evaluate(() => {
      const links = [...document.querySelectorAll("a")];
      const storeLink = links.find(a => /winkel|store|filiaal/i.test(a.textContent) || /store|winkel|filiaal/i.test(a.href));
      return storeLink?.href || null;
    });
    if (href) {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(5000);
      // Try searching
      const input = await page.$("input[type='text']");
      if (input && stores.length === 0) {
        await input.fill("België");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(5000);
      }
    }
    // Fallback: extract from HTML
    if (stores.length === 0) {
      const htmlStores = await page.evaluate(() => {
        const html = document.documentElement.innerHTML;
        const results = [];
        for (const m of html.matchAll(/"lat(?:itude)?":\s*(5[01]\.\d{3,})[\s\S]*?"ln?g(?:itude)?":\s*(\d\.\d{3,})/g)) {
          results.push({ lat: Number(m[1]), lon: Number(m[2]) });
        }
        return results;
      });
      stores.push(...htmlStores.map(s => store(s.lat, s.lon, "Aldi")));
    }
    return dedup(stores);
  });
}

// ---- Intermarché (Brightdata - load store pages with JS) ----
async function fetchIntermarcheStores() {
  // First get all store page URLs from sitemap
  const smRes = await fetch("https://www.intermarche.be/store-sitemap.xml");
  if (!smRes.ok) return [];
  const xml = await smRes.text();
  const urls = [...xml.matchAll(/<loc>(https:\/\/www\.intermarche\.be\/(?:magasins|nl\/winkels)\/[^<]+)<\/loc>/g)].map(m => m[1]);
  if (!urls.length) return [];
  console.log(`[stores] Intermarché: ${urls.length} store pages found`);

  // Use Brightdata to load a few pages and extract coords via JS rendering
  return withBrightdata(async (page) => {
    const stores = [];
    // Load each store page and extract coords from the Google Maps embed
    for (const url of urls) {
      if (url.endsWith("/") && !url.includes("intermarche-")) continue; // skip index pages
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.waitForTimeout(1500);
        const data = await page.evaluate(() => {
          // Look for Google Maps iframe with @lat,lon
          const iframe = document.querySelector("iframe[src*='google.com/maps']");
          if (iframe) {
            const m = iframe.src.match(/@(5[01]\.\d+),([\d.]+)/) || iframe.src.match(/q=([^&]+)/);
            if (m && m[1] && Number(m[1]) > 49) return { lat: Number(m[1]), lon: Number(m[2]) };
          }
          // Look for coords in page data
          const html = document.documentElement.innerHTML;
          const coordMatch = html.match(/"latitude":\s*"?(5[01]\.[\d]+)"?\s*,\s*"longitude":\s*"?([\d.]+)/);
          if (coordMatch) return { lat: Number(coordMatch[1]), lon: Number(coordMatch[2]) };
          return null;
        });
        if (data) {
          const name = "Intermarché " + url.split("/").filter(Boolean).pop().replace(/-/g, " ").replace(/intermarche\s*/i, "");
          stores.push(store(data.lat, data.lon, name));
        }
      } catch {}
    }
    return dedup(stores);
  });
}

// ---- OKay/Bio-Planet (same method as Colruyt) ----

// ---- AH (Brightdata - load store page) ----
async function fetchAHStores() {
  return withBrightdata(async (page) => {
    const stores = [];
    page.on("response", async (res) => {
      try {
        const ct = res.headers()["content-type"] || "";
        if (!ct.includes("json")) return;
        const json = await res.json();
        const arr = json.stores || json.cards || json.data || json.items || (Array.isArray(json) ? json : null);
        if (!arr || arr.length < 3) return;
        for (const s of arr) {
          const lat = Number(s.lat || s.latitude || s.location?.latitude);
          const lon = Number(s.lng || s.longitude || s.location?.longitude);
          if (lat > 49 && lat < 52) stores.push(store(lat, lon, s.name || "Albert Heijn", s.address?.city || s.city, s.address?.street || s.street, s.address?.postalCode || s.postalCode));
        }
      } catch {}
    });
    await page.goto("https://www.ah.be/winkels", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(5000);
    // Try interacting with the page to load more stores
    const input = await page.$("input[type='text']");
    if (input) {
      for (const q of ["Brussel", "Antwerpen", "Gent", "Luik"]) {
        await input.fill(q);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2000);
      }
    }
    return dedup(stores);
  });
}

// ---- Diagnostic (unchanged) ----
export async function diagnoseStoreLocators() {
  // ... kept for debugging
  return {};
}

// ---- Main ----
export async function scrapeAllStoreLocators() {
  const results = {};
  const errors = [];

  // Plain fetch (fast, no Brightdata cost)
  for (const [name, fn] of [["Bon'Ap", fetchBonapStores], ["Hubo", fetchHuboStores]]) {
    try { const s = await fn(); console.log(`[stores] ${name}: ${s.length}`); if (s.length > 0) results[name] = s; }
    catch (e) { console.log(`[stores] ${name} FAILED: ${e.message.split("\n")[0]}`); errors.push(`${name}: ${e.message.split("\n")[0]}`); }
  }

  // Brightdata (sequential - one session at a time)
  const brightdataChains = [
    ["Action", fetchActionStores],
    ["Colruyt", () => fetchColruytGroupStores("clp", "https://www.colruyt.be/nl", "Colruyt")],
    ["OKay", () => fetchColruytGroupStores("oka", "https://www.okay.be/nl", "OKay")],
    ["Bio-Planet", () => fetchColruytGroupStores("bpl", "https://www.bioplanet.be/nl", "Bio-Planet")],
    ["Carrefour", fetchCarrefourStores],
    ["Aldi", fetchAldiStores],
    ["Albert Heijn", fetchAHStores],
    ["Intermarché", fetchIntermarcheStores],
  ];

  for (const [name, fn] of brightdataChains) {
    try {
      const s = await fn();
      console.log(`[stores] ${name}: ${s.length}`);
      if (s.length > 0) results[name] = s;
    } catch (e) {
      console.log(`[stores] ${name} FAILED: ${e.message.split("\n")[0]}`);
      errors.push(`${name}: ${e.message.split("\n")[0]}`);
    }
  }

  return { results, errors };
}
