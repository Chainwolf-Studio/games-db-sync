/**
 * Sincronizare App Store -> Google Sheets (GitHub Actions).
 * Sursa: iTunes Lookup API (gratuit, public). Fara scraping, fara cheie.
 */

import { google } from 'googleapis';

const SPREADSHEET_ID = '1BSMwXovXJxuX8XyfQA5kxZJPT54Kgkpzg4APXDTZb7k';
const SHEET_NAME = 'AppStore';
const COUNTRY = 'DE';      // DE = preturi in EUR
const LANG = 'en_us';
const SLEEP_MS = 1000;
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const NEW_ONLY = process.env.NEW_ONLY === '1';  // 1 = proceseaza doar randuri fara 'name'

function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchApp(id) {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${COUNTRY}&lang=${LANG}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const js = await res.json();
    if (!js.results || !js.results.length) return null;
    const a = js.results[0];

    const icon = a.artworkUrl512 || a.artworkUrl100 || a.artworkUrl60 || '';
    let release = '';
    if (a.releaseDate) { const d = new Date(a.releaseDate); if (!isNaN(d.getTime())) release = d.toISOString().substring(0, 10); }

    let priceText = a.formattedPrice || '';
    const priceNum = (typeof a.price === 'number') ? a.price : null;
    const isFree = (priceNum === 0) || /free|gratis/i.test(priceText);
    if (!priceText && isFree) priceText = 'Free';

    // Categorie curata: scoatem "Games", pastram subcategoriile
    const catList = Array.isArray(a.genres) ? a.genres.filter(x => x && x.toLowerCase() !== 'games') : [];
    const category = catList.length ? catList.join(', ') : (a.primaryGenreName || '');

    const ratingScore = (typeof a.averageUserRating === 'number') ? Math.round(a.averageUserRating * 10) / 10 : '';
    const ratingCount = (typeof a.userRatingCount === 'number') ? a.userRatingCount : 0;

    // IAP: aproximam (free -> probabil DA)
    const iap = isFree ? 'TRUE' : '';  // gol la platite -> completare manuala

    return {
      name: a.trackName || '',
      icon: icon,
      url: a.trackViewUrl || '',
      developer: a.artistName || a.sellerName || '',
      release_date: release,
      price: priceText,
      rating_count: ratingCount,
      rating_score: ratingScore,
      category: category,
      in_app_purchases: iap,
    };
  } catch (e) { return null; }
}

async function main() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const read = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = read.data.values || [];
  if (rows.length < 2) { console.log('Fila goala.'); return; }

  const header = rows[0].map(h => String(h).trim());
  const col = {}; header.forEach((h, i) => { if (h) col[h] = i; });
  if (col['appstore_id'] === undefined) { console.error('Nu gasesc coloana appstore_id'); process.exit(1); }

  const updates = [];
  let processed = 0, failed = 0;
  const now = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });

  for (let r = 1; r < rows.length; r++) {
    if (LIMIT > 0 && processed >= LIMIT) break;
    const id = String(rows[r][col['appstore_id']] || '').trim();
    if (!/^\d+$/.test(id)) continue;

    if (NEW_ONLY && col['name'] !== undefined && String(rows[r][col['name']]||'').trim() !== '') continue;
    console.log(`[${r}] ${id} ...`);
    const data = await fetchApp(id);

    if (data) {
      Object.keys(data).forEach(key => {
        if (col[key] === undefined) return;
        // nu scrie IAP gol peste valoare manuala existenta
        if (key === 'in_app_purchases' && data[key] === '') return;
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
  while (idx > 0) { const m = (idx - 1) % 26; s = String.fromCharCode(65 + m) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}

main().catch(e => { console.error(e); process.exit(1); });
