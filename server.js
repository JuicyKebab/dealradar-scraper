import express from "express";
import { scrapeAllRenmans, probeRenmans } from "./scrapers/renmans.js";
import { scrapeAllBakkersonline } from "./scrapers/bakkersonline.js";
import { scrapeAllSlagersonline } from "./scrapers/slagersonline.js";
import { scrapeAllDrinxit } from "./scrapers/drinxit.js";
import { scrapeAllPrikentik } from "./scrapers/prikentik.js";
import { scrapeAlvo } from "./scrapers/alvo.js";
import { scrapeLidl } from "./scrapers/lidl-flyer.js";
import { scrapeAmazingOriental } from "./scrapers/amazing-oriental.js";
import { scrapeAula } from "./scrapers/aula.js";
import { scrapeAH } from "./scrapers/ah.js";
import { scrapeAction } from "./scrapers/action.js";
import { scrapeCarrefour } from "./scrapers/carrefour.js";
import { scrapeDelhaize } from "./scrapers/delhaize.js";
import { scrapeOkay } from "./scrapers/okay.js";
import { scrapeBioplanet } from "./scrapers/bioplanet.js";
import { probeBioplanet } from "./scrapers/bioplanet-probe.js";
import { probeColruyt } from "./scrapers/colruyt-probe.js";
import { scrapeColruytPromos } from "./scrapers/colruyt-promos.js";
import { scrapeCallens } from "./scrapers/callens.js";
import { scrapeVercammen } from "./scrapers/vercammen.js";
import { scrapeVersleverancier } from "./scrapers/versleverancier.js";
import { scrapeRechtvantveld } from "./scrapers/rechtvantveld.js";
import { scrapeGroentebroer } from "./scrapers/groentebroer.js";
import { scrapeHubo } from "./scrapers/hubo.js";
import { scrapeIntermarche } from "./scrapers/intermarche.js";
import { scrapeBonap } from "./scrapers/bonap.js";
import { scrapeAveve } from "./scrapers/aveve.js";
import { scrapeBrico } from "./scrapers/brico.js";
import { scrapeCoolblue } from "./scrapers/coolblue.js";
import { scrapeVanAsten } from "./scrapers/vanasten.js";
import { scrapeArtAndCraft } from "./scrapers/artencraft.js";
import { scrapeAllStoreLocators, diagnoseStoreLocators } from "./scrapers/store-locators.js";
import { scrapeDeals } from "./scrapers/deals.js";
import { scrapeFarmaline } from "./scrapers/farmaline.js";
import { scrapeNationalStores } from "./scrapers/national-stores.js";
import { logScrape } from "./lib/logScrape.js";
import cron from "node-cron";

const app = express();
app.use(express.json());

const CRON_SECRET = process.env.CRON_SECRET;


app.post("/scrape-bakkersonline", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const t = Date.now();
  try {
    const result = await scrapeAllBakkersonline();
    const durationMs = Date.now() - t;
    await logScrape({ source: "bakkersonline", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeAllBakkersonline failed:", err);
    await logScrape({ source: "bakkersonline", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-slagersonline", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const t = Date.now();
  try {
    const result = await scrapeAllSlagersonline();
    const durationMs = Date.now() - t;
    await logScrape({ source: "slagersonline", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeAllSlagersonline failed:", err);
    await logScrape({ source: "slagersonline", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-drinxit", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const t = Date.now();
  try {
    const result = await scrapeAllDrinxit();
    const durationMs = Date.now() - t;
    await logScrape({ source: "drinxit", dealCount: result.count ?? result.total ?? 0, errors: [], durationMs, emptyOk: result.emptyState === true }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeAllDrinxit failed:", err);
    await logScrape({ source: "drinxit", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-prikentik", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const t = Date.now();
  try {
    const result = await scrapeAllPrikentik();
    const durationMs = Date.now() - t;
    await logScrape({ source: "prikentik", dealCount: result.count ?? result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeAllPrikentik failed:", err);
    await logScrape({ source: "prikentik", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/probe-renmans", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await probeRenmans();
    res.json({ ok: result.ok, ...result });
  } catch (err) {
    console.error("[server] probeRenmans failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-renmans", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // Respond immediately — scrape runs in background (~20 min for 223 stores)
  res.status(202).json({ ok: true, status: "started" });
  const t = Date.now();
  scrapeAllRenmans()
    .then(async (result) => {
      const durationMs = Date.now() - t;
      await logScrape({ source: "renmans", dealCount: result.counts?.total ?? 0, errors: [], durationMs }).catch(() => {});
      console.log(`[server] scrapeAllRenmans done: ${result.counts?.total} deals in ${durationMs}ms`);
    })
    .catch(async (err) => {
      const durationMs = Date.now() - t;
      console.error("[server] scrapeAllRenmans failed:", err);
      await logScrape({ source: "renmans", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    });
});


app.post("/scrape-alvo", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const t = Date.now();
  try {
    const result = await scrapeAlvo();
    const durationMs = Date.now() - t;
    await logScrape({ source: "alvo", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeAlvo failed:", err);
    await logScrape({ source: "alvo", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-lidl", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const t = Date.now();
  try {
    const result = await scrapeLidl();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Lidl", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeLidl failed:", err);
    await logScrape({ source: "Lidl", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-tanger", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  // Geparkeerd: Tanger-folder is een platte PNG zonder tekstlaag -> vereist vision/OCR
  // (Anthropic-credits). Geen no-op-scrape om valse failed-logs/alerts te vermijden.
  // Reactiveren: hieronder scrapeTanger() herstellen zodra credits/Gemini beschikbaar zijn.
  console.log("[server] scrape-tanger overgeslagen — bron geparkeerd (vereist vision, geen credits)");
  res.json({ ok: true, skipped: true, reason: "tanger geparkeerd: folder is een platte afbeelding, vereist vision/OCR" });
});

app.post("/scrape-amazingoriental", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const t = Date.now();
  try {
    const result = await scrapeAmazingOriental();
    const durationMs = Date.now() - t;
    await logScrape({ source: "amazingoriental", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeAmazingOriental failed:", err);
    await logScrape({ source: "amazingoriental", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-aula", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const t = Date.now();
  try {
    const result = await scrapeAula();
    const durationMs = Date.now() - t;
    await logScrape({ source: "aula", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeAula failed:", err);
    await logScrape({ source: "aula", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-ah", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const t = Date.now();
  try {
    const result = await scrapeAH();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Albert Heijn", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeAH failed:", err);
    await logScrape({ source: "Albert Heijn", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-action", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const diagnose = req.query.diagnose === "1";
  const t = Date.now();
  try {
    const result = await scrapeAction({ diagnose });
    const durationMs = Date.now() - t;
    if (!diagnose) await logScrape({ source: "action", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeAction failed:", err);
    if (!diagnose) await logScrape({ source: "action", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-carrefour", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // Direct antwoorden — scrape draait ~8 min op de achtergrond (residentiële proxy, ~60 paginas).
  // Anders breekt de Vercel-cron af op 280s en logt een valse fout terwijl de data wél landt.
  res.status(202).json({ ok: true, status: "started" });
  const t = Date.now();
  scrapeCarrefour()
    .then(async (result) => {
      const durationMs = Date.now() - t;
      await logScrape({ source: "Carrefour", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
      console.log(`[server] scrapeCarrefour done: ${result.total} deals in ${durationMs}ms`);
    })
    .catch(async (err) => {
      const durationMs = Date.now() - t;
      console.error("[server] scrapeCarrefour failed:", err);
      await logScrape({ source: "Carrefour", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    });
});

app.post("/scrape-delhaize", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // Respond immediately — scrape runs in background (Brightdata-latency kan >300s zijn,
  // boven Railway's HTTP-request-limiet; scrapeDelhaize() schrijft de cache zelf weg).
  res.status(202).json({ ok: true, status: "started" });
  const t = Date.now();
  scrapeDelhaize()
    .then(async (result) => {
      const durationMs = Date.now() - t;
      await logScrape({ source: "Delhaize", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
      console.log(`[server] scrapeDelhaize done: ${result.total} deals in ${durationMs}ms`);
    })
    .catch(async (err) => {
      const durationMs = Date.now() - t;
      console.error("[server] scrapeDelhaize failed:", err);
      await logScrape({ source: "Delhaize", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    });
});

app.post("/scrape-okay", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeOkay();
    const durationMs = Date.now() - t;
    const errors = result.paginationFailed
      ? [`Pagination failed (${result.paginationStopReason}): ${result.total}/${result.totalFound} deals, lastPage=${result.lastPage}`]
      : [];
    await logScrape({ source: "OKay", dealCount: result.total ?? 0, errors, durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeOkay failed:", err);
    await logScrape({ source: "OKay", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-bioplanet", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeBioplanet();
    const durationMs = Date.now() - t;
    const errors = result.total === 0 && result.diag ? [`0 deals after retry - title: ${result.diag.title}, url: ${result.diag.url}, cards: ${result.diag.cardCount}`] : [];
    await logScrape({ source: "Bio-Planet", dealCount: result.total ?? 0, errors, durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeBioplanet failed:", err);
    await logScrape({ source: "Bio-Planet", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-callens", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeCallens();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Callens", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeCallens failed:", err);
    await logScrape({ source: "Callens", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-vercammen", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeVercammen();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Vercammen", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeVercammen failed:", err);
    await logScrape({ source: "Vercammen", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-versleverancier", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeVersleverancier();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Versleverancier", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeVersleverancier failed:", err);
    await logScrape({ source: "Versleverancier", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-rechtvantveld", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeRechtvantveld();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Rechtvantveld", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeRechtvantveld failed:", err);
    await logScrape({ source: "Rechtvantveld", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Dillen GEPARKEERD (1 aug 2026): dillen-groentenfruit.be geeft 403 op alles
// (homepage + WooCommerce API), óók voor een echte browser vanaf residentieel IP.
// Site-brede WAF-blokkade, niet fixbaar onze kant. Handler is een no-op zodat er
// geen `failed`-logs/alerts meer komen. Scraper (scrapers/dillen.js) blijft intact;
// verwijder deze short-circuit + herstel de scrape-logica om te reactiveren.
app.post("/scrape-dillen", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  console.log("[server] scrape-dillen overgeslagen — bron geparkeerd (site 403)");
  res.json({ ok: true, skipped: true, reason: "dillen geparkeerd: site blokkeert alle toegang (403)" });
});

app.post("/scrape-groentebroer", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeGroentebroer();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Groentebroer", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeGroentebroer failed:", err);
    await logScrape({ source: "Groentebroer", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/probe-bioplanet", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = await probeBioplanet();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[server] probeBioplanet failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-colruyt-promos", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = await scrapeColruytPromos();
    res.json(result);
  } catch (err) {
    console.error("[server] scrapeColruytPromos failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/colruyt-probe", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = await probeColruyt();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[server] probeColruyt failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-hubo", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeHubo();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Hubo", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeHubo failed:", err);
    await logScrape({ source: "Hubo", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-intermarche", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeIntermarche();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Intermarché", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeIntermarche failed:", err);
    await logScrape({ source: "Intermarché", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-bonap", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeBonap();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Bonap", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeBonap failed:", err);
    await logScrape({ source: "Bonap", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-aveve", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeAveve();
    const durationMs = Date.now() - t;
    await logScrape({ source: "Aveve", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeAveve failed:", err);
    await logScrape({ source: "Aveve", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-brico", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeBrico();
    const durationMs = Date.now() - t;
    await logScrape({ source: "brico", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeBrico failed:", err);
    await logScrape({ source: "brico", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-coolblue", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const diagnose = req.query.diagnose === "1";
    const result = await scrapeCoolblue({ diagnose });
    if (diagnose) return res.json(result);
    const durationMs = Date.now() - t;
    await logScrape({ source: "coolblue", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeCoolblue failed:", err);
    await logScrape({ source: "coolblue", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-artencraft", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeArtAndCraft();
    const durationMs = Date.now() - t;
    await logScrape({ source: "artencraft", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeArtAndCraft failed:", err);
    await logScrape({ source: "artencraft", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/scrape-vanasten", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const t = Date.now();
  try {
    const result = await scrapeVanAsten();
    const durationMs = Date.now() - t;
    await logScrape({ source: "vanasten", dealCount: result.total ?? 0, errors: [], durationMs }).catch(() => {});
    res.json({ ok: true, ...result, scraped_at: new Date().toISOString() });
  } catch (err) {
    const durationMs = Date.now() - t;
    console.error("[server] scrapeVanAsten failed:", err);
    await logScrape({ source: "vanasten", dealCount: 0, errors: [err.message], durationMs }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Diagnose store locator pages (debug) ──
app.post("/diagnose-stores", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  try {
    const results = await diagnoseStoreLocators();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dump store locations (Overpass + chain APIs) → Supabase cache ──
app.post("/dump-stores", async (req, res) => {
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true, status: "started" });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6;

  const CHAIN_MAP = {
    "colruyt":"Colruyt","lidl":"Lidl","delhaize":"Delhaize","ad delhaize":"Delhaize",
    "proxy delhaize":"Delhaize","aldi":"Aldi","jumbo":"Jumbo","albert heijn":"Albert Heijn",
    "ah":"Albert Heijn","action":"Action","carrefour":"Carrefour","carrefour market":"Carrefour",
    "carrefour express":"Carrefour","carrefour hypermarket":"Carrefour","okay":"OKay",
    "ok\u00e9":"OKay","bio-planet":"Bio-Planet","bio planet":"Bio-Planet","hubo":"Hubo",
    "brico":"Brico","intermarch\u00e9":"Intermarch\u00e9","intermarche":"Intermarch\u00e9",
    "bon'ap":"Bon'Ap","bon ap":"Bon'Ap","bonap":"Bon'Ap","aveve":"Aveve",
  };

  try {
    // 1. Lidl API
    console.log("[dump-stores] Lidl...");
    const lidlStores = [];
    for (let offset = 0; offset < 1000; offset += 250) {
      const r = await fetch(`https://live.api.schwarz/odj/stores-api/v2/myapi/stores-frontend/stores?locale=nl-BE&country_code=BE&offset=${offset}&limit=250`,
        { headers: { "x-apikey": (process.env.LIDL_STORE_API_KEY || "KxboQtt40BG4VpBL16IhaRd2CXh0QbAc") } });
      if (!r.ok) break;
      const j = await r.json();
      for (const s of j.items || []) {
        if (!s.address?.latitude) continue;
        lidlStores.push({ lat: r6(s.address.latitude), lon: r6(s.address.longitude), name: s.storeName || "Lidl",
          city: s.address.city || "", street: s.address.streetName || "", housenumber: s.address.streetNumber || "", postcode: s.address.zip || "" });
      }
      if ((j.items || []).length < 250) break;
    }
    console.log(`[dump-stores] Lidl: ${lidlStores.length}`);

    // 2. Delhaize GraphQL
    console.log("[dump-stores] Delhaize...");
    const delStores = [];
    for (let page = 0; page < 3; page++) {
      const r = await fetch("https://www.delhaize.be/api/v1/", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `{storeSearch(pageSize:1000,currentPage:${page}){stores{name address{line1 town postalCode}geoPoint{latitude longitude}}}}` }),
      });
      if (!r.ok) break;
      const j = await r.json();
      const stores = j?.data?.storeSearch?.stores || [];
      for (const s of stores) {
        if (!s.geoPoint?.latitude) continue;
        const parts = (s.address?.line1 || "").match(/^(.+?)\s+(\d+\S*)$/) || [];
        delStores.push({ lat: r6(s.geoPoint.latitude), lon: r6(s.geoPoint.longitude), name: s.name ? "Delhaize " + s.name : "Delhaize",
          city: s.address?.town || "", street: parts[1] || s.address?.line1 || "", housenumber: parts[2] || "", postcode: s.address?.postalCode || "" });
      }
      if (stores.length < 1000) break;
    }
    console.log(`[dump-stores] Delhaize: ${delStores.length}`);

    // 3. Aveve (HTML store locator)
    console.log("[dump-stores] Aveve...");
    const aveveStores = [];
    try {
      const avRes = await fetch("https://www.aveve.be/nl/winkels", { signal: AbortSignal.timeout(15000) });
      if (avRes.ok) {
        const avHtml = await avRes.text();
        const avJson = avHtml.match(/(\[\s*\{[^}]*"lat"[\s\S]*?\}\s*\])/);
        if (avJson) {
          const arr = JSON.parse(avJson[1]);
          for (const s of arr) {
            if (!s.lat || !s.lng) continue;
            const p = (s.address || "").match(/^(.+?)\s*,\s*(\d{4})\s+(.+)$/);
            aveveStores.push({ lat: r6(s.lat), lon: r6(s.lng), name: s.name || "Aveve",
              street: p?.[1] || s.address || "", housenumber: "", postcode: p?.[2] || "", city: p?.[3] || "" });
          }
        }
      }
    } catch (e) { console.log("[dump-stores] Aveve error:", e.message); }
    console.log(`[dump-stores] Aveve: ${aveveStores.length}`);

    // 4. Overpass (alle andere ketens)
    console.log("[dump-stores] Overpass...");
    const overpassResult = {};
    const query = `[out:json][timeout:120];area["ISO3166-1"="BE"]->.be;(nw["shop"~"^(supermarket|variety_store|discount|doityourself|garden_centre)$"](area.be);nw["shop"="butcher"]["name"~"Bon.?Ap",i](area.be););out center;`;
    const mirrors = ["https://overpass-api.de/api/interpreter","https://lz4.overpass-api.de/api/interpreter","https://z.overpass-api.de/api/interpreter"];
    let data = null;
    for (const url of mirrors) {
      try {
        console.log(`[dump-stores] Trying ${new URL(url).hostname}...`);
        const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query),
          headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(120000) });
        if (r.ok) { data = await r.json(); console.log(`[dump-stores] OK: ${data.elements.length} elements`); break; }
        console.log(`[dump-stores] HTTP ${r.status}`);
      } catch (e) { console.log(`[dump-stores] ${e.message}`); }
    }
    if (data?.elements) {
      for (const el of data.elements) {
        const tags = el.tags || {};
        const nameLC = ((tags.brand || tags.name) || "").toLowerCase().trim();
        let chain = null;
        for (const [key, val] of Object.entries(CHAIN_MAP)) { if (nameLC.includes(key)) { chain = val; break; } }
        if (!chain) continue;
        const lat = el.center?.lat ?? el.lat;
        const lon = el.center?.lon ?? el.lon;
        if (!lat || !lon) continue;
        if (!overpassResult[chain]) overpassResult[chain] = [];
        overpassResult[chain].push({ lat: r6(lat), lon: r6(lon), name: tags.name || chain,
          street: tags["addr:street"] || "", housenumber: tags["addr:housenumber"] || "", postcode: tags["addr:postcode"] || "", city: tags["addr:city"] || "" });
      }
    } else {
      console.log("[dump-stores] Overpass failed on all mirrors");
    }

    // 5. Brightdata store locators (Colruyt, Aldi, Action, Carrefour, Hubo, Brico, Intermarche, Bon'Ap)
    console.log("[dump-stores] Brightdata store locators...");
    let brightdataStores = {};
    try {
      const { results: bdResults, errors: bdErrors } = await scrapeAllStoreLocators();
      brightdataStores = bdResults;
      for (const e of bdErrors) console.log("[dump-stores] BD:", e);
    } catch (e) { console.log("[dump-stores] Brightdata failed:", e.message); }

    // Merge: API data wins, then Brightdata, then Overpass
    const results = { ...overpassResult };
    for (const [chain, stores] of Object.entries(brightdataStores)) {
      if (stores.length > 0) results[chain] = stores;
    }
    if (lidlStores.length > 0) results.Lidl = lidlStores;
    if (delStores.length > 0) results.Delhaize = delStores;
    if (aveveStores.length > 0) results.Aveve = aveveStores;

    // Dedup
    for (const chain of Object.keys(results)) {
      const seen = new Set();
      results[chain] = results[chain].filter(s => {
        const key = `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
    }

    // Merge with existing Supabase data (keep chains we couldn't fetch)
    const existing = await fetch(`${SUPABASE_URL}/rest/v1/cache?key=eq.national_stores&select=data`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }).then(r => r.json()).catch(() => []);
    if (existing?.[0]?.data) {
      for (const [chain, stores] of Object.entries(existing[0].data)) {
        if (!results[chain] || results[chain].length === 0) results[chain] = stores;
      }
    }

    const total = Object.values(results).reduce((s, a) => s + a.length, 0);
    const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1]));
    console.log("[dump-stores] Total:", total, "stores in", Object.keys(results).length, "chains");
    console.log("[dump-stores]", JSON.stringify(summary));

    if (total < 50) { console.log("[dump-stores] Too few stores, skipping write"); return; }

    // Write to Supabase
    const existingRow = await fetch(`${SUPABASE_URL}/rest/v1/cache?key=eq.national_stores&select=key`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }).then(r => r.json());
    const method = existingRow?.length > 0 ? "PATCH" : "POST";
    const url = existingRow?.length > 0 ? `${SUPABASE_URL}/rest/v1/cache?key=eq.national_stores` : `${SUPABASE_URL}/rest/v1/cache`;
    const wr = await fetch(url, { method,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(method === "POST" ? { key: "national_stores", data: results, updated_at: new Date().toISOString() } : { data: results, updated_at: new Date().toISOString() }),
    });
    console.log("[dump-stores] Supabase write:", wr.ok ? "OK" : wr.status);
  } catch (e) {
    console.error("[dump-stores] Error:", e.message);
  }
});

// ── Geport van Vercel (/api/scrape, /api/scrape-farmaline, /api/scrape-stores) ──
app.post("/scrape-deals", async (req, res) => {
  if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ ok: true, ...(await scrapeDeals()), scraped_at: new Date().toISOString() }); }
  catch (err) { console.error("[server] scrapeDeals failed:", err); res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/scrape-farmaline", async (req, res) => {
  if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ ...(await scrapeFarmaline()), scraped_at: new Date().toISOString() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/scrape-stores", async (req, res) => {
  if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ ...(await scrapeNationalStores()), scraped_at: new Date().toISOString() }); }
  catch (err) { console.error("[server] scrapeNationalStores failed:", err); res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/health", async (_, res) => {
  try {
    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/cache?key=eq.deals&select=data,updated_at`,
      { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const rows = await r.json();
    const row = rows[0];
    res.json({ ok: true, cachedAt: row?.updated_at, dealCount: row?.data?.length ?? 0 });
  } catch {
    res.json({ ok: true });
  }
});

const PORT = process.env.PORT || 3001;

// ── Cron-scheduler (DORMANT tot ENABLE_CRON="true") ──────────────────────────
// Repliceert vercel.json 1-op-1. Lokale scrapers → Railway-endpoints (POST op
// 127.0.0.1); app-logica (reports/mail/log-prices/...) → de Next-app (GET) via
// CRON_TARGET_BASE. Tijden in UTC, exact zoals vercel.json.
//
// NIET activeren zolang de Vercel-crons nog draaien → anders dubbel scrapen én
// DUBBELE WEEKMAIL (harde regel). Flip ENABLE_CRON=true pas bij cutover, nadat de
// crons in vercel.json zijn verwijderd. CRON_TARGET_BASE: nu Vercel-URL/dealoco.be,
// na cutover de CF-Worker (dealoco.be).
const APP_BASE = (process.env.CRON_TARGET_BASE || "https://dealoco.be").replace(/\/$/, "");
const LOCAL_BASE = `http://127.0.0.1:${PORT}`;

// [cronExpr (UTC), kind, path]  kind: "local" = POST Railway, "app" = GET Next-app
const CRON_JOBS = [
  // Gegenereerd uit vercel.json (houd 1-op-1 gelijk; wijzig tijden eerst daar)
  ["0 16 * * 3,4,5",       "app",   "api/newsletter/weekly"],
  ["0 7 * * *",            "app",   "api/newsletter/onboarding"],
  ["0 2 * * *",            "local", "scrape-deals"],          // Aldi + Jumbo (Railway-port van /api/scrape)
  ["0 3 * * 1,4",          "local", "scrape-lidl"],
  ["40 3 * * 1,4",         "local", "scrape-colruyt-promos"],
  ["0 5 * * *",            "local", "scrape-artencraft"],
  ["25 4 * * 1",           "local", "scrape-bakkersonline"],
  ["15 11 * * 1",          "local", "scrape-slagersonline"],
  ["30 5 * * *",           "local", "scrape-farmaline"],
  ["15 8 * * 1",           "local", "scrape-drinxit"],
  ["45 8 * * 1",           "local", "scrape-prikentik"],
  ["15 9 * * 1",           "local", "scrape-alvo"],
  ["10 7 * * 4",           "local", "scrape-tanger"],
  ["10 8 * * 4",           "local", "scrape-action"],
  ["10 9 * * 4",           "local", "scrape-carrefour"],
  ["55 3 * * 1",           "local", "scrape-amazingoriental"],
  ["0 3 * * 0",            "local", "scrape-ah"],
  ["30 2 * * 1,4",         "local", "scrape-delhaize"],
  ["10 3 * * 1,4",         "local", "scrape-okay"],
  ["45 4 * * 1",           "local", "scrape-bioplanet"],
  ["15 5 * * 1",           "local", "scrape-callens"],
  ["45 5 * * 1",           "local", "scrape-vercammen"],
  ["15 6 * * 1",           "local", "scrape-versleverancier"],
  ["45 6 * * 1",           "local", "scrape-rechtvantveld"],
  ["15 7 * * 1",           "local", "scrape-dillen"],
  ["45 7 * * 1",           "local", "scrape-groentebroer"],
  ["25 3 * * 1",           "local", "scrape-renmans"],
  ["0 4 * * 4",            "local", "scrape-hubo"],
  ["10 5 * * 4",           "local", "scrape-intermarche"],
  ["15 10 * * 1",          "local", "scrape-bonap"],
  ["45 9 * * 1",           "local", "scrape-aveve"],
  ["45 10 * * 1",          "local", "scrape-brico"],
  ["10 4 * * *",           "local", "scrape-coolblue"],
  ["0 9 * * *",            "app",   "api/push/notify"],
  ["0 8 * * 0,2,3,4,5,6",  "app",   "api/report/daily"],
  ["30 8 * * 1",           "app",   "api/report/weekly"],
  ["15 1 * * 1",           "app",   "api/cleanup"],
  ["0 1 * * *",            "local", "scrape-stores"],
  ["45 11 * * 1",          "app",   "api/blog/weekly"],
  ["0 10 * * *",           "app",   "api/log-prices"],
  ["0 6 * * *",            "app",   "api/indexnow"],
  ["0 12 * * 1",           "app",   "api/batch-translate"],
  ["*/5 * * * *",          "app",   "api/health-supabase"],
  ["0 9 1 * *",            "app",   "api/newsletter/sunset-report"],
];

async function runCronJob(kind, path) {
  const url = kind === "local" ? `${LOCAL_BASE}/${path}` : `${APP_BASE}/${path}`;
  const method = kind === "local" ? "POST" : "GET";
  const t = Date.now();
  try {
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    console.log(`[cron] ${method} ${path} → ${r.status} (${Date.now() - t}ms)`);
  } catch (err) {
    console.error(`[cron] ${path} FAILED:`, err.message);
  }
}

if (process.env.ENABLE_CRON === "true") {
  if (!CRON_SECRET) {
    console.error("[cron] ENABLE_CRON=true maar CRON_SECRET ontbreekt — scheduler NIET gestart");
  } else {
    let bad = 0;
    for (const [expr, kind, path] of CRON_JOBS) {
      if (!cron.validate(expr)) { console.error(`[cron] ongeldige expr "${expr}" voor ${path}`); bad++; continue; }
      cron.schedule(expr, () => runCronJob(kind, path), { timezone: "UTC" });
    }
    console.log(`[cron] scheduler ACTIEF: ${CRON_JOBS.length - bad} jobs (UTC), app-base=${APP_BASE}`);
  }
} else {
  console.log("[cron] scheduler DORMANT — zet ENABLE_CRON=true bij cutover (en verwijder dan vercel.json crons)");
}

app.listen(PORT, () => console.log(`Railway scraper listening on port ${PORT}`));
