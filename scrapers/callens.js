// Fruithandel Callens scraper — HTTP fetch + regex tekst-parsing (geen credits nodig)
// Site heeft SSL cert mismatch (bilbo.plenso.net), dus HTTP gebruiken.
// De promo staat als schone <p>-regels ("Product: 2 kilo €3") in div.promo-this,
// dus geen vision/LLM nodig — een regex parseert naam/deal/prijs rechtstreeks.
import { parse as parseHtml } from "node-html-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STORE_LAT = 50.8282;
const STORE_LON = 3.2641;
const STORE_CITY = "Kortrijk";
const STORE_ADDRESS = "Walle 16, 8500 Kortrijk";

const _DAYS   = ["zo","ma","di","wo","do","vr","za"];
const _MONTHS = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function dutchDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`;
}

function parsePromoDate(text) {
  // "PROMOTIES 23/04-29/04" of "03/09 - 09/09" → "wo 29 april" (spaties rond streepje toegestaan)
  const m = text.match(/(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})/);
  if (!m) return dutchDate(7);
  const endDay = parseInt(m[3]);
  const endMonth = parseInt(m[4]) - 1;
  const year = new Date().getFullYear();
  const d = new Date(year, endMonth, endDay);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d < today) d.setFullYear(year + 1);
  return `${_DAYS[d.getDay()]} ${endDay} ${_MONTHS[endMonth]}`;
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
    body: JSON.stringify({ key: "callens", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

function extractPrice(txt) {
  const m = txt.match(/€\s?(\d+(?:[.,]\d{1,2})?)/);
  return m ? parseFloat(m[1].replace(",", ".")) : 0;
}

export async function scrapeCallens() {
  // 1. Fetch HTML via HTTP (SSL cert klopt niet voor dit domein)
  const res = await fetch("http://www.fruithandel-callens.be/kleinhandel/promoties", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const html = await res.text();

  // 2. Parse HTML
  const root = parseHtml(html);
  const promoDiv = root.querySelector("div.promo-this");
  if (!promoDiv) throw new Error("div.promo-this not found — paginastructuur mogelijk gewijzigd");

  const paragraphs = promoDiv.querySelectorAll("p");
  if (!paragraphs.length) throw new Error("Geen <p> tags gevonden in div.promo-this");

  // 3. Geldigheid uit eerste paragraph: "PROMOTIES 23/04-29/04"
  let validUntil = dutchDate(7);
  const firstText = paragraphs[0]?.text || "";
  if (/PROMOTIES/i.test(firstText)) {
    validUntil = parsePromoDate(firstText);
  }

  // 4. Verzamel dealregels (skip header, skip leeg)
  const lines = [];
  for (const p of paragraphs) {
    const text = p.text.replace(/\u00a0/g, " ").trim();
    if (!text || /^PROMOTIES\s+\d/i.test(text)) continue;
    lines.push(text);
  }

  if (lines.length === 0) throw new Error("Geen promotieregels gevonden");
  console.log(`[Callens] ${lines.length} regels gevonden, geldig tot: ${validUntil}`);

  // 5. Regex-parser: elke regel is "Productnaam: <deal met €-prijs>".
  //    Colli-deals ("Groentencolli €6") hebben geen dubbelpunt; hun sub-items
  //    (regels zonder ":" en zonder €) worden overgeslagen.
  const seen = new Set();
  const deals = [];
  for (const line of lines) {
    if (/^PROMOTIES\s+\d/i.test(line)) continue;
    let name = null, dealPart = null;
    const colon = line.lastIndexOf(":");
    if (colon > 0) {
      name = line.slice(0, colon).trim();
      dealPart = line.slice(colon + 1).trim();
    } else {
      const m = line.match(/^(.*?colli)\s*(€.*)$/i);
      if (m) { name = m[1].trim(); dealPart = m[2].trim(); }
    }
    if (!name || !dealPart) continue;                 // sub-item / geen deal

    const newPrice = extractPrice(dealPart);
    const pct = dealPart.match(/-\s?(\d+)\s?%/);
    const savings = pct ? parseInt(pct[1]) : 0;
    if (newPrice === 0 && savings === 0 && !/gratis/i.test(dealPart)) continue; // geen prijs/aanbod

    const deal = dealPart.replace(/\s*OP=OP\s*/i, " ").replace(/\s+/g, " ").trim();
    const id = `callens-${slugify(name)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    deals.push({
      id,
      store: "Callens",
      shopName: "Fruithandel Callens",
      storeColor: "#2e7d32",
      storeLogo: "FC",
      storeLat: STORE_LAT,
      storeLon: STORE_LON,
      storeCity: STORE_CITY,
      storeAddress: STORE_ADDRESS,
      item: name,
      deal,
      category: "Groenten & Fruit",
      originalPrice: 0,
      newPrice,
      savings,
      validUntil,
      hot: savings >= 30,
      emoji: "🥦",
    });
  }

  if (deals.length === 0) throw new Error("Geen Callens deals geparsed");
  await supabaseWrite(deals);
  console.log(`[Callens] ${deals.length} deals opgeslagen`);
  return { total: deals.length };
}
