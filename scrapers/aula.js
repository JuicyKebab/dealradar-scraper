// Slagerij Aula scraper — Voldersstraat 24, 9000 Gent
// Statische WordPress/Elementor pagina, maandelijkse promos
// Formaat: "Bij aankoop van X → Y gratis"
import { parse as parseHtml } from "node-html-parser";
import { logScrape } from "../lib/logScrape.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const URL = "https://slagerij-aula.com/promos/";
const STORE_LAT = 51.0535;
const STORE_LON = 3.7218;

const _DAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december"];

function endOfMonth() {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${_DAYS[last.getDay()]} ${last.getDate()} ${_MONTHS[last.getMonth()]}`;
}

function categorize(text) {
  const t = text.toLowerCase();
  if (t.match(/soep|tomaten|bouillon/)) return "Overig";
  if (t.match(/kaas|stokbrood|brood/)) return "Overig";
  if (t.match(/choco|mousse|dessert/)) return "Overig";
  return "Vlees & Vis";
}

async function fetchDeals() {
  const res = await fetch(URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "nl-BE,nl;q=0.9",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const root = parseHtml(html);

  const validUntil = endOfMonth();
  const deals = [];

  // Structuur op de pagina: elke deal bestaat uit opeenvolgende <h2> tags:
  //   "Bij aankoop van" | [koopartikel] | [gratis hoeveelheid] | [gratis artikel] | "gratis"
  const h2Texts = root.querySelectorAll("h2")
    .map(el => el.textContent.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (let i = 0; i < h2Texts.length; i++) {
    if (h2Texts[i].toLowerCase() !== "bij aankoop van") continue;

    const buyItem = h2Texts[i + 1] || "";
    if (!buyItem) continue;

    // Verzamel alles tot "gratis"
    const freeParts = [];
    let j = i + 2;
    while (j < h2Texts.length && h2Texts[j].toLowerCase() !== "gratis") {
      freeParts.push(h2Texts[j]);
      j++;
    }
    const freeItem = freeParts.join(" ");
    if (!freeItem) continue;

    const itemName = buyItem.charAt(0).toUpperCase() + buyItem.slice(1);
    const dealText = `Gratis: ${freeItem}`;
    const category = categorize(buyItem + " " + freeItem);

    deals.push({
      id: `aula-${Buffer.from(buyItem).toString("base64").slice(0, 12)}`,
      store: "Slagerij Aula",
      shopName: "Slagerij Aula",
      storeColor: "#b71c1c",
      storeLogo: "SA",
      emoji: category === "Vlees & Vis" ? "🥩" : "🛒",
      item: itemName,
      deal: dealText,
      category,
      originalPrice: 0,
      newPrice: 0,
      savings: 0,
      image: "",
      hot: false,
      validUntil,
      storeLat: STORE_LAT,
      storeLon: STORE_LON,
    });

    i = j; // sla "gratis" over, ga verder na dit blok
  }

  return deals;
}

async function supabaseWrite(deals) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase env vars ontbreken");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: "aula", data: deals, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write mislukt: ${res.status} ${await res.text()}`);
}

export async function scrapeAula() {
  const t0 = Date.now();
  const errors = [];
  let deals = [];

  try {
    deals = await fetchDeals();
    await supabaseWrite(deals);
  } catch (err) {
    errors.push(err.message);
    console.error("[aula] scrape error:", err.message);
  }

  const durationMs = Date.now() - t0;
  await logScrape({ source: "aula", dealCount: deals.length, errors, durationMs });
  console.log(`[aula] ${deals.length} deals in ${durationMs}ms`);
  return { total: deals.length, errors };
}
