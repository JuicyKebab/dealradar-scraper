// Recht van 't Veld scraper — HTML parsing van promoties-pagina
// Server-rendered .thumbnail cards op /nl/promoties/index.htm
import { parse as parseHtml } from "node-html-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STORE_LAT = 51.0968;
const STORE_LON = 4.5127;
const STORE_CITY = "Duffel";
const STORE_ADDRESS = "Naalstraat 37d, 2570 Duffel";

const _DAYS   = ["zo","ma","di","wo","do","vr","za"];
const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
const _MONTH_NL = { januari:0, februari:1, maart:2, april:3, mei:4, juni:5, juli:6, augustus:7, september:8, oktober:9, november:10, december:11 };

function toDutchDate(day, month0, year) {
  const d = new Date(year, month0, day);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

// Parses end date from strings like:
//   "21-04 tot en met 26-04"
//   "Van 21 april tot en met 26 april"
function parseEndDate(texts) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const year = today.getFullYear();

  for (const t of texts) {
    // Format: "DD-MM tot en met DD-MM"
    const numMatch = t.match(/(\d{1,2})-(\d{2})\s+tot\s+en\s+met\s+(\d{1,2})-(\d{2})/i);
    if (numMatch) {
      let endDay = parseInt(numMatch[3]);
      let endMonth = parseInt(numMatch[4]) - 1;
      let d = new Date(year, endMonth, endDay);
      if (d < today) d = new Date(year + 1, endMonth, endDay);
      return toDutchDate(endDay, d.getMonth(), d.getFullYear());
    }

    // Format: "Van DD maand tot en met DD maand"
    const nlMatch = t.match(/tot\s+en\s+met\s+(\d{1,2})\s+([a-z]+)/i);
    if (nlMatch) {
      const endDay = parseInt(nlMatch[1]);
      const endMonth = _MONTH_NL[nlMatch[2].toLowerCase()];
      if (endMonth !== undefined) {
        let d = new Date(year, endMonth, endDay);
        if (d < today) d = new Date(year + 1, endMonth, endDay);
        return toDutchDate(endDay, d.getMonth(), d.getFullYear());
      }
    }
  }

  // Fallback: 7 days from now
  const fb = new Date();
  fb.setDate(fb.getDate() + 7);
  return toDutchDate(fb.getDate(), fb.getMonth(), fb.getFullYear());
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
    body: JSON.stringify({ key: "rechtvantveld", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

export async function scrapeRechtvantveld() {
  const res = await fetch("https://www.rechtvantveld.be/nl/promoties/index.htm", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const html = await res.text();

  const root = parseHtml(html);
  const cards = root.querySelectorAll(".thumbnail");
  if (!cards.length) throw new Error("Geen .thumbnail elementen gevonden — paginastructuur gewijzigd");

  const deals = [];

  for (const card of cards) {
    const name = card.querySelector("h4")?.text?.trim();
    if (!name) continue;

    // Collect all <p> texts
    const pTexts = card.querySelectorAll("p").map(p => p.text.trim()).filter(Boolean);

    // Price: find first <p> containing €
    const priceText = pTexts.find(t => t.includes("€")) || "";
    const priceMatch = priceText.match(/€\s*(\d+[,.]?\d*)/);
    if (!priceMatch) continue; // skip deals without a clear price
    const newPrice = parseFloat(priceMatch[1].replace(",", "."));
    if (!newPrice || newPrice <= 0) continue;

    // End date
    const validUntil = parseEndDate(pTexts);

    // Image: add https: prefix to protocol-relative URLs
    const imgSrc = card.querySelector("img")?.getAttribute("src") || null;
    const image = imgSrc ? (imgSrc.startsWith("//") ? `https:${imgSrc}` : imgSrc) : null;

    const id = `rechtvantveld-${slugify(name)}`;

    deals.push({
      id,
      store: "Rechtvantveld",
      shopName: "Recht van 't Veld",
      storeColor: "#33691e",
      storeLogo: "RV",
      storeLat: STORE_LAT,
      storeLon: STORE_LON,
      storeCity: STORE_CITY,
      storeAddress: STORE_ADDRESS,
      item: name,
      deal: "Weekaanbieding",
      category: "Groenten & Fruit",
      originalPrice: 0,
      newPrice,
      savings: 0,
      validUntil,
      hot: false,
      emoji: "🥦",
      image,
    });
  }

  if (deals.length === 0) throw new Error("Geen deals geparseerd");

  await supabaseWrite(deals);
  console.log(`[Rechtvantveld] ${deals.length} deals opgeslagen`);
  return { total: deals.length };
}
