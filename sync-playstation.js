/**
 * Sincronizare PlayStation -> Google Sheets (GitHub Actions).
 * Scraping PS Store (JSON-LD + __NEXT_DATA__ escape-uit).
 * Pret USD -> EUR. Cu rating si discount.
 */

import { google } from 'googleapis';

const SPREADSHEET_ID = '1BSMwXovXJxuX8XyfQA5kxZJPT54Kgkpzg4APXDTZb7k';
const SHEET_NAME = 'PlayStation';
const SLEEP_MS = 2000;
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const NEW_ONLY = process.env.NEW_ONLY === '1';  // 1 = proceseaza doar randuri fara 'name'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let _rate = null;
async function getUsdToEur() {
  if (_rate !== null) return _rate;
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD');
    if (res.ok) { const j = await res.json(); _rate = (j.rates && j.rates.USD) ? (1 / j.rates.USD) : 0.92; return _rate; }
  } catch (e) {}
  _rate = 0.92; return _rate;
}
function formatEur(amount) {
  const n = Math.round(amount * 100) / 100;
  const p = n.toFixed(2).split('.');
  return p[0] + ',' + p[1] + ' €';
}

async function fetchGame(url) {
  let html = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (res.status === 200) { html = await res.text(); break; }
      if (res.status === 429 || res.status === 503) { await sleep(3000 * (attempt + 1)); continue; }
      if (res.status === 404) return null;
      await sleep(1500 * (attempt + 1));
    } catch (e) { await sleep(2000 * (attempt + 1)); }
  }
  if (!html) return null;

  const out = {};

  // JSON-LD: nume, imagine, gen
  const m = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m) {
    try {
      const g = JSON.parse(m[1].trim());
      if (g && g.name) {
        out.name = g.name || '';
        out.icon = (typeof g.image === 'string') ? g.image : (g.image && g.image.url ? g.image.url : '');
        if (g.genre) out.genres = Array.isArray(g.genre) ? g.genre.join(', ') : String(g.genre);
      }
    } catch (e) {}
  }

  // __NEXT_DATA__ escape-uit
  const nd = html.indexOf('__NEXT_DATA__');
  let j = '';
  if (nd !== -1) {
    const start = html.indexOf('>', nd) + 1;
    const end = html.indexOf('</script>', start);
    j = html.substring(start, end);
  }

  function grabStr(key) {
    const re = new RegExp('\\\\?"' + key + '\\\\?":\\\\?"([^"\\\\]+)');
    const mm = j.match(re);
    return mm ? mm[1] : null;
  }
  function grabNum(key) {
    const re = new RegExp('\\\\?"' + key + '\\\\?":([\\d.]+)');
    const mm = j.match(re);
    return mm ? parseFloat(mm[1]) : null;
  }

  if (!out.name) {
    const nm = grabStr('name');
    if (nm) out.name = nm;
  }
  if (!out.name) return null;

  const pub = grabStr('publisherName');
  if (pub) { out.publisher = pub; out.developer = pub; }

  const rd = j.match(/\\?"releaseDate\\?":\\?"(\d{4}-\d{2}-\d{2})/);
  if (rd) out.release_date = rd[1];

  const pm = j.match(/\\?"platforms\\?":\[([^\]]+)\]/);
  if (pm) {
    const plats = []; const re = /\\?"([A-Z0-9]+)\\?"/g; let mm;
    while ((mm = re.exec(pm[1])) !== null) plats.push(mm[1]);
    if (plats.length) out.platforms = plats.join(', ');
  }

  const ar = grabNum('averageRating');
  const rc = grabNum('totalRatingsCount');
  if (ar !== null && rc && rc > 0) { out.rating = Math.round(ar * 10) / 10; out.rating_count = Math.round(rc); }

  // Gen din localizedGenres
  if (!out.genres) {
    const gm = j.match(/\\?"localizedGenres\\?":\[([^\]]*)\]/);
    if (gm) {
      const vals = []; const re = /\\?"value\\?":\\?"([^"\\]+)/g; let mm;
      while ((mm = re.exec(gm[1])) !== null) vals.push(mm[1]);
      if (vals.length) out.genres = vals.join(', ');
    }
  }

  // Pret din valori numerice (centi)
  const base = grabNum('basePriceValue');
  const disc = grabNum('discountedValue');
  const rate = await getUsdToEur();
  if (base !== null) {
    const baseUsd = base / 100;
    const finalUsd = (disc !== null) ? disc / 100 : baseUsd;
    if (finalUsd === 0) out.price_current = 'Free';
    else out.price_current = formatEur(finalUsd * rate);
    if (disc !== null && disc < base) {
      out.price_original = formatEur(baseUsd * rate);
      out.price_discount = Math.round((1 - disc / base) * 100);
    } else out.price_discount = 0;
  }

  return out;
}

async function main() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const read = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = read.data.values || [];
  if (rows.length < 2) { console.log('Fila goala.'); return; }

  const header = rows[0].map(h => String(h).trim());
  const col = {}; header.forEach((h, i) => { if (h) col[h] = i; });
  if (col['ps_url'] === undefined) { console.error('Nu gasesc coloana ps_url'); process.exit(1); }

  const updates = [];
  let processed = 0, failed = 0;
  const now = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });

  for (let r = 1; r < rows.length; r++) {
    if (LIMIT > 0 && processed >= LIMIT) break;
    const url = String(rows[r][col['ps_url']] || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;

    if (NEW_ONLY && col['name'] !== undefined && String(rows[r][col['name']]||'').trim() !== '') continue;
    console.log(`[${r}] ${url} ...`);
    const data = await fetchGame(url);

    if (data && data.name) {
      Object.keys(data).forEach(key => {
        if (col[key] === undefined) return;
        updates.push({ range: `${SHEET_NAME}!${colLetter(col[key])}${r + 1}`, values: [[data[key]]] });
      });
      if (col['sync_status'] !== undefined) updates.push({ range: `${SHEET_NAME}!${colLetter(col['sync_status'])}${r + 1}`, values: [['OK']] });
      if (col['last_synced'] !== undefined) updates.push({ range: `${SHEET_NAME}!${colLetter(col['last_synced'])}${r + 1}`, values: [[now]] });
      processed++;
      console.log(`    OK: ${data.name}`);
    } else {
      failed++;
      if (col['sync_status'] !== undefined) updates.push({ range: `${SHEET_NAME}!${colLetter(col['sync_status'])}${r + 1}`, values: [['Not found']] });
      console.log('    esuat');
    }
    await sleep(SLEEP_MS);
  }

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
    });
  }
  console.log(`\nGata. Procesate: ${processed}, esuate: ${failed}, celule: ${updates.length}`);
}

function colLetter(idx) {
  let s = ''; idx = idx + 1;
  while (idx > 0) { const mm = (idx - 1) % 26; s = String.fromCharCode(65 + mm) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}

main().catch(e => { console.error(e); process.exit(1); });
