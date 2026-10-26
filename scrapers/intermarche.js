// Intermarché BE scraper — HTTP fetch via Brightdata residential proxy
// (datacenter IPs get empty pages from intermarche.be)
// Products are server-rendered in HTML with pdw-product-item class

import { ProxyAgent, fetch as undiciFetch } from "undici";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BD_HOST = process.env.BRIGHTDATA_HOST;
const BD_USER = process.env.BRIGHTDATA_USER;
const BD_PASS = process.env.BRIGHTDATA_PASS;
const USE_PROXY = !!(BD_HOST && BD_USER && BD_PASS);

const proxyUrl = USE_PROXY
  ? `http://${BD_USER}:${BD_PASS}@${BD_HOST.includes(":") ? BD_HOST : BD_HOST + ":22225"}`
  : null;
const proxyDispatcher = proxyUrl ? new ProxyAgent({
  uri: proxyUrl,
  requestTls: { rejectUnauthorized: false },
  proxyTls: { rejectUnauthorized: false },
}) : null;

const BASE_URL = "https://www.intermarche.be/nl/producten/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Sept 2026: intermarche.be serveert datacenter-IPs weer normaal. De Brightdata
// residential proxy kapte de scrape juist af (rotating IP per request verloor de
// sessie → lege/herhaalde pagina's → ~42 i.p.v. ~200 promo's). Daarom direct-first:
// plain fetch, en enkel bij blokkade/lege HTML terugvallen op de proxy.
async function fetchHtml(url) {
  const attempts = proxyDispatcher ? [false, true] : [false];
  for (const useProxy of attempts) {
    try {
      const r = await (useProxy ? undiciFetch : globalThis.fetch)(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20_000),
        ...(useProxy ? { dispatcher: proxyDispatcher } : {}),
      });
      if (!r.ok) continue;
      const html = await r.text();
      if (html.includes("pdw-product-item")) return html;
    } catch { /* probeer volgende transport */ }
  }
  return "";
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parsePromo(bannerText) {
  if (!bannerText) return { deal: null, savings: 0 };
  const t = bannerText.trim().replace(/\*+$/, "").trim();
  const pct = t.match(/-(\d+)%/);
  if (pct) return { deal: t.replace(/\s+NAAR KEUZE.*/i, "").trim(), savings: parseInt(pct[1]) };
  if (/1\+1\s*gratis/i.test(t)) return { deal: t, savings: 50 };
  if (/2de\s+aan\s+-?50/i.test(t)) return { deal: t, savings: 25 };
  if (/2de\s+aan\s+-?(\d+)/i.test(t)) { const m = t.match(/-?(\d+)/); return { deal: t, savings: m ? Math.round(parseInt(m[1]) / 2) : 0 }; }
  if (/4\+1/i.test(t)) return { deal: t, savings: 20 };
  if (/3\+1/i.test(t)) return { deal: t, savings: 25 };
  if (/2\+1/i.test(t)) return { deal: t, savings: 33 };
  return { deal: t, savings: 0 };
}

function parseDealsFromHtml(html) {
  const deals = [];
  const blocks = html.split(/class="card pdw-product-item/).slice(1);
  for (const raw of blocks) {
    const block = raw.slice(0, 2000);
    const ref = block.match(/data-reference="([^"]+)"/)?.[1] || "";
    // Titel staat soms in <b> (merk), soms in <strong> (productnaam) — beide pakken.
    const titleMatch = block.match(/<(?:b|strong)>([^<]+)<\/(?:b|strong)>/);
    const title = titleMatch?.[1]?.trim();
    if (!title) continue;

    const priceMatch = block.match(/pdw-price">[\s\S]*?(\d+)<sup>(\d+)<\/sup>/);
    const newPrice = priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : null;

    const oldMatch = block.match(/pdw-price-stroke[\s\S]*?(\d+[.,]\d+)/);
    const origPrice = oldMatch ? parseFloat(oldMatch[1].replace(",", ".")) : null;

    const bannerMatch = block.match(/pdw-promo-banner">\s*([^<]+)/);
    const banner = bannerMatch?.[1]?.trim() || null;

    const imgMatch = block.match(/wp-post-image[^>]*src="([^"]+)"/);
    const image = imgMatch?.[1] || null;

    let { deal, savings } = parsePromo(banner);
    if (origPrice && newPrice && savings === 0 && origPrice > newPrice) {
      savings = Math.round((1 - newPrice / origPrice) * 100);
      if (!deal) deal = `-${savings}%`;
    }
    if (!deal && newPrice !== null) deal = `€${newPrice.toFixed(2).replace(".", ",")}`;
    if (!deal) continue;

    deals.push({
      id: ref ? `intermarche-${slugify(ref)}` : `intermarche-${slugify(title)}`,
      store: "Intermarché",
      storeColor: "#e30613",
      storeLogo: "IM",
      emoji: "\uD83D\uDED2",
      item: title,
      deal, category: "Overig",
      originalPrice: origPrice ?? null,
      newPrice: newPrice ?? null,
      savings, validUntil: "",
      hot: savings >= 30, image, url: null,
    });
  }
  return deals;
}

async function supabaseWrite(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "intermarche", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

export async function scrapeIntermarche() {
  // Fetch page 1 to get total count
  const html1 = await fetchHtml(BASE_URL);
  if (!html1) throw new Error("Intermarche page 1: lege HTML (direct + proxy gefaald)");

  const totalMatch = html1.match(/(\d+)\s*producten/);
  const total = totalMatch ? parseInt(totalMatch[1]) : 0;
  const nbPages = total > 0 ? Math.min(Math.ceil(total / 12), 25) : 1;
  console.log(`[intermarche] ${total} producten, ${nbPages} pagina's`);

  const allDeals = [];
  const seen = new Set();
  const addDeals = (pageDeals) => {
    for (const d of pageDeals) { if (!seen.has(d.id)) { seen.add(d.id); allDeals.push(d); } }
  };

  // Parse page 1
  addDeals(parseDealsFromHtml(html1));
  console.log(`[intermarche] pagina 1/${nbPages}: ${allDeals.length} deals`);

  // Fetch remaining pages in parallel (batches of 5)
  for (let batch = 2; batch <= nbPages; batch += 5) {
    const pages = [];
    for (let p = batch; p < batch + 5 && p <= nbPages; p++) pages.push(p);
    const results = await Promise.allSettled(
      pages.map(p => fetchHtml(`${BASE_URL}?_pagination=${p}`))
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled" && results[i].value) {
        const before = allDeals.length;
        addDeals(parseDealsFromHtml(results[i].value));
        console.log(`[intermarche] pagina ${pages[i]}/${nbPages}: ${allDeals.length - before} nieuw`);
      }
    }
  }

  console.log(`[intermarche] ${allDeals.length} deals totaal`);
  if (allDeals.length > 0) await supabaseWrite(allDeals);
  return { total: allDeals.length };
}
