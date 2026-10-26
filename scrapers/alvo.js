// Alvo scraper — Publitas folder via de spreads.json text-laag (geen vision/credits nodig).
// Alvo (supermarkt) rendert productnamen in ALL-CAPS (meerdere regels), prijzen als
// oud/nieuw-paar ("3,98 2,99") of "PROMOPRIJS <prijs>", mechanismen (1+1/2+1/3+1 GRATIS,
// 2e aan -50%, -NN%). De foldertekst is een platgeslagen kolom-lay-out; conservatieve
// parser: enkel deals met een echt kortingssignaal (mechanisme OF oud/nieuw ≥10%).
// Folder bevat meerdere weken -> per-pagina einddatum, verlopen weken overgeslagen.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const _DAYS   = ["zo", "ma", "di", "wo", "do", "vr", "za"];
const _MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FOLDER_BASE = "https://view.publitas.com/alvo/folder-deze-week";

const NUM = (s) => parseFloat(String(s).replace(",", "."));

function fmtDutch(d) { return `${_DAYS[d.getDay()]} ${d.getDate()} ${_MONTHS[d.getMonth()]}`; }
function dutchDate(daysFromNow = 7) { const d = new Date(); d.setDate(d.getDate() + daysFromNow); return fmtDutch(d); }

function slugify(str) { return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

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
    body: JSON.stringify({ key: "alvo", data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status}`);
}

// --- Tekst-parser -----------------------------------------------------------

// Herbouw gesplitste prijzen: "2," + "39" -> "2,39"
function normLines(raw) {
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\d{1,3},$/.test(l) && i + 1 < lines.length && /^\d{2}$/.test(lines[i + 1])) { out.push(l + lines[i + 1]); i++; continue; }
    out.push(l);
  }
  return out;
}

// Section headers / labels die GEEN productnaam zijn
const SECTION = /^(PROMOPRIJS|SUPERPROMO|GRATIS\**|AANBIEDINGEN?|GELDIG|ALVO|AFDELING|VESTIGING|KLANTENKAART|VOORDELEN|SUPER|BIJV|AAN|VERS VLEES|ZUIVEL|DIEPVRIES|DRANKEN|KRUIDENIER|VERZORGING|HUISHOUDEN|ONTBIJT|BROOD|KAAS|VLEESWAREN|GROENTEN|FRUIT|RECEPTPROMO|ONTDEK|LEKKER)\**$/i;
const BAD_NAME = /^(aan|van|en|extra|stuk|het recept|de |per |bij aankoop|gratis|assortiment)/i;

const isCaps = (l) => {
  if (l.length < 2 || l.length > 44) return false;
  if (/\d[.,]\d/.test(l)) return false;
  const letters = l.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length < 2) return false;
  const upper = l.replace(/[^A-ZÀ-Ÿ]/g, "").length;
  return upper >= letters.length * 0.75 && /^[A-ZÀ-Ÿ0-9]/.test(l);
};

function parseEndDate(str) {
  const m = str.match(/T\.E\.M\.?\s*(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?/i);
  if (!m) return null;
  const now = new Date();
  return new Date(m[3] ? +m[3] : now.getFullYear(), +m[2] - 1, +m[1]);
}

function mechanism(b) {
  let m;
  if (/3\s*\+\s*1\s*\**\s*gratis/i.test(b)) return { deal: "3+1 GRATIS", sav: 25 };
  if (/2\s*\+\s*1\s*\**\s*gratis/i.test(b)) return { deal: "2+1 GRATIS", sav: 33 };
  if (/1\s*\+\s*1\s*\**\s*gratis/i.test(b)) return { deal: "1+1 GRATIS", sav: 50 };
  if ((m = b.match(/2e\s+aan\s*-?\s*(\d+)\s*%/i))) return { deal: `2e aan -${m[1]}%`, sav: +m[1] };
  if ((m = b.match(/-\s*(\d+)\s*%/))) return { deal: `-${m[1]}%`, sav: +m[1] };
  return null;
}

// Oud/nieuw paar: "3,98 2,99" (eerste > tweede), eventueel met /qty ertussen
function pricePair(b) {
  const m = b.match(/(\d+[.,]\d{2})\s*(?:\/\d+)?\s+(\d+[.,]\d{2})/);
  if (m) { const a = NUM(m[1]), c = NUM(m[2]); if (a > c && c > 0 && a < c * 6) return { orig: a, new: c }; }
  return null;
}

function categorize(name) {
  const n = name.toLowerCase();
  if (/melk|yogh|kaas|boter|room|actimel|zuivel|drink|alpro/.test(n)) return "Zuivel";
  if (/bier|pils|cola|wijn|abdij|water|fris|d.oc|bag-in-box/.test(n)) return "Dranken";
  if (/chocola|koek|snoep|m&m|reep|donut|snack|biscuit/.test(n)) return "Chocolade & Snoep";
  if (/was|douche|reiniger|toiletpapier|verband|doekjes|babydoek|verzorg|shampoo|luiers|tampon|mondwater|pants/.test(n)) return "Huishouden";
  if (/vlees|kip|varken|rund|gyros|steak|worst|ham|salami|filet|schnitzel|forel|tonijn|vis|zalm|jam[oó]n/.test(n)) return "Vlees & Vis";
  if (/pizza|oven|airfryer|diepvries|ijs|magnum/.test(n)) return "Diepvries";
  if (/brood|buns|sandwich|granen|brioche/.test(n)) return "Bakkerij & Snacks";
  if (/olie|rijst|pasta|saus|quinoa|ketjap|smaakverfijner|bouillon|koffie/.test(n)) return "Droogwaren";
  if (/komkommer|sla|kiwi|wortel|avocado|fruit|groente/.test(n)) return "Groenten & Fruit";
  return "Overig";
}

function parsePageDeals(lines, validUntil) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (SECTION.test(lines[i]) || !isCaps(lines[i])) continue;
    // caps-run = productnaam (max 4 regels)
    const run = [lines[i]];
    let j = i + 1;
    while (j < lines.length && isCaps(lines[j]) && !SECTION.test(lines[j]) && run.length < 4) { run.push(lines[j]); j++; }
    let name = run.join(" ").replace(/\bgratis\**/ig, "").replace(/\*+/g, "").replace(/\s+/g, " ").trim();
    // block = van naam tot volgende caps-run (max 12 regels)
    let bEnd = j;
    while (bEnd < lines.length && !(isCaps(lines[bEnd]) && !SECTION.test(lines[bEnd])) && bEnd < j + 12) bEnd++;
    const block = lines.slice(i, bEnd).join(" ");
    const mech = mechanism(block);
    const pair = pricePair(block);
    let newP = 0, origP = 0, deal, savings;
    if (pair) { origP = pair.orig; newP = pair.new; }
    if (mech) { deal = mech.deal; savings = mech.sav; }
    else if (pair) { deal = "Promoprijs"; savings = Math.round((origP - newP) / origP * 100); }
    else { i = j - 1; continue; }             // geen kortingssignaal
    if (!mech && savings < 10) { i = j - 1; continue; }
    const nice = name.charAt(0) + name.slice(1).toLowerCase();
    if (nice.length < 4 || BAD_NAME.test(nice)) { i = j - 1; continue; }
    out.push({
      id: `alvo-${slugify(name)}`,
      store: "Alvo",
      storeColor: "#006838",
      storeLogo: "A",
      item: nice,
      deal,
      category: categorize(name),
      originalPrice: origP,
      newPrice: newP,
      savings,
      validUntil,
      hot: savings >= 30,
    });
    i = j - 1;
  }
  return out;
}

export async function scrapeAlvo() {
  // spreads.json direct via HTTP (geen Playwright/vision meer)
  const res = await fetch(`${FOLDER_BASE}/spreads.json`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`spreads.json HTTP ${res.status}`);
  const spreads = await res.json();
  if (!Array.isArray(spreads) || !spreads.length) throw new Error("Could not capture Alvo Publitas folder data");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fallbackUntil = dutchDate(7);

  const seen = new Set();
  const deals = [];
  for (const sp of spreads) for (const pg of sp.pages || []) {
    const text = pg.text || "";
    const end = parseEndDate(text);
    if (end && end < today) continue;          // verlopen week overslaan
    const validUntil = end ? fmtDutch(end) : fallbackUntil;
    for (const deal of parsePageDeals(normLines(text), validUntil)) {
      if (seen.has(deal.id)) continue;
      seen.add(deal.id);
      deals.push(deal);
    }
  }

  console.log(`[alvo] ${deals.length} deals na parsing`);
  if (deals.length === 0) throw new Error("Geen Alvo deals gevonden");

  await supabaseWrite(deals);
  return { total: deals.length };
}
