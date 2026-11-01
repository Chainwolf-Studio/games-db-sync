/**
 * Sincronizare Nintendo -> Google Sheets (GitHub Actions).
 * Scraping pagina Nintendo Store (JSON-LD + __NEXT_DATA__).
 * Pret USD -> convertit in EUR. Cu discount.
 */

import { google } from 'googleapis';

const SPREADSHEET_ID = '1BSMwXovXJxuX8XyfQA5kxZJPT54Kgkpzg4APXDTZb7k';
const SHEET_NAME = 'Nintendo';
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

  // JSON-LD
  const m = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m) {
    try {
      const obj = JSON.parse(m[1].trim());
      const nodes = obj['@graph'] || [obj];
      let g = null;
      for (const n of nodes) {
        const t = n['@type']; const types = Array.isArray(t) ? t : [t];
        if (types.indexOf('VideoGame') !== -1 || types.indexOf('Product') !== -1) { g = n; break; }
      }
      if (g) {
        out.name = g.name || '';
        out.icon = g.image || g.thumbnailUrl || '';
        if (g.publisher) out.publisher = (typeof g.publisher === 'string') ? g.publisher : (g.publisher.name || '');
        out.developer = out.publisher || '';
        if (g.gamePlatform) out.platform = Array.isArray(g.gamePlatform) ? g.gamePlatform.join(', ') : String(g.gamePlatform);
        if (g.numberOfPlayers && g.numberOfPlayers.minValue) {
          const mn = g.numberOfPlayers.minValue, mx = g.numberOfPlayers.maxValue;
          out.players = (mx && mx > mn) ? (mn + '-' + mx + ' jucatori') : (mn + (mn == 1 ? ' jucator' : ' jucatori'));
        }
        if (g.genre) out.genres = Array.isArray(g.genre) ? g.genre.join(', ') : String(g.genre);
      }
    } catch (e) {}
  }
  if (!out.name) return null;

  // __NEXT_DATA__
  const nd = html.indexOf('__NEXT_DATA__');
  if (nd !== -1) {
    const start = html.indexOf('>', nd) + 1;
    const end = html.indexOf('</script>', start);
    const j = html.substring(start, end);

    const rd = j.match(/"releaseDate":"(\d{4}-\d{2}-\d{2})/);
    if (rd) out.release_date = rd[1];

    if (!out.genres) {
      const gm = j.match(/"genres":\[(.*?)\]/);
      if (gm) {
        const labels = []; const re = /"label":"([^"]+)"/g; let mm;
        while ((mm = re.exec(gm[1])) !== null) labels.push(mm[1]);
        if (labels.length) out.genres = labels.join(', ');
      }
    }

    const rp = j.match(/"regularPrice":([\d.]+),"finalPrice":([\d.]+)(?:,"pricePerUnit":[^,]*,"percentOff":([\d.]+))?/);
    if (rp) {
      const regular = parseFloat(rp[1]);
      const final = parseFloat(rp[2]);
      const pct = rp[3] ? Math.round(parseFloat(rp[3])) : 0;
      const rate = await getUsdToEur();
      if (final === 0) out.price_current = 'Free';
      else out.price_current = formatEur(final * rate);
      if (pct > 0 && regular > final) {
        out.price_original = formatEur(regular * rate);
        out.price_discount = pct;
      } else out.price_discount = 0;
    }
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
  if (col['nintendo_url'] === undefined) { console.error('Nu gasesc coloana nintendo_url'); process.exit(1); }

  const updates = [];
  let processed = 0, failed = 0;
  const now = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });

  for (let r = 1; r < rows.length; r++) {
    if (LIMIT > 0 && processed >= LIMIT) break;
    const url = String(rows[r][col['nintendo_url']] || '').trim();
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
