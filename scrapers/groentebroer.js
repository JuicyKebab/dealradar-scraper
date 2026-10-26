// Groentebroer scraper — product cards via node-html-parser
import { parse as parseHtml } from "node-html-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const _DAYS   = ["zo","ma","di","wo","do","vr","za"];
const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

async function supabaseWrite(data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing Supabase env vars");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "groentebroer", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

export async function scrapeGroentebroer() {
  const res = await fetch("https://groentebroer.be/acties/producten", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const html = await res.text();

  const root = parseHtml(html);
  const deals = [];
  const seen = new Set();
  const validUntil = dutchDate(7);

  // Product title links: <a href="...groenten/sub/slug" class="product-title">
  const titleLinks = root.querySelectorAll("a.product-title").filter(a => {
    const href = a.getAttribute("href") || "";
    return /(?:groenten|fruit)\/[^/]+\/[^/]+/.test(href);
  });

  for (const link of titleLinks) {
    const rawHref = link.getAttribute("href") || "";
    const path = rawHref.replace(/^https?:\/\/groentebroer\.be/, "");
    const slug = path.replace(/^\//, "").replace(/\/$/, "");
    if (seen.has(slug)) continue;
    seen.add(slug);

    // Product name from h2 inside the link
    const heading = link.querySelector("h1, h2, h3, h4");
    const name = heading?.text?.trim() || link.text?.trim() || "";
    if (!name || name.length < 2) continue;

    // Price is in a sibling .product-meta div after the link
    // Walk up to the common parent and find .product-meta
    const parent = link.parentNode;
    const metaEl = parent?.querySelector(".product-meta");
    const metaText = metaEl?.text || "";

    // "per stuk - 0,25" or "1 bos - 2,99" or "per 500 gram - 5,99"
    const priceMatch = metaText.match(/(\d+[,]\d{2})/);
    if (!priceMatch) continue;
    const newPrice = parseFloat(priceMatch[1].replace(",", "."));
    if (!newPrice || newPrice <= 0) continue;

    // Image: look in ancestor card for product-image
    const grandParent = parent?.parentNode;
    const img = grandParent?.querySelector("img.product-image")?.getAttribute("src") ||
                grandParent?.parentNode?.querySelector("img.product-image")?.getAttribute("src") || null;

    deals.push({
      id: `groentebroer-${slug.replace(/\//g, "-")}`,
      productUrl: `https://groentebroer.be${path}`,
      store: "Groenten & Fruit",
      shopName: "Groentebroer",
      storeColor: "#558b2f",
      storeLogo: "GB",
      storeLat: null,
      storeLon: null,
      storeCity: "Vlaanderen & Brussel",
      storeAddress: "Bezorgdienst",
      item: name,
      deal: "Weekaanbieding",
      category: "Groenten & Fruit",
      originalPrice: 0,
      newPrice,
      savings: 0,
      validUntil,
      hot: false,
      emoji: "\uD83E\uDD66",
      image: img,
    });
  }

  if (deals.length === 0) throw new Error("Geen deals geparseerd — HTML structuur mogelijk gewijzigd");

  await supabaseWrite(deals);
  console.log(`[Groentebroer] ${deals.length} deals opgeslagen`);
  return { total: deals.length };
}
