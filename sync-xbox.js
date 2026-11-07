/**
 * Sincronizare Xbox -> Google Sheets (GitHub Actions).
 * Sursa: Microsoft Display Catalog (public, fara cheie).
 */

import { google } from 'googleapis';

const SPREADSHEET_ID = '1BSMwXovXJxuX8XyfQA5kxZJPT54Kgkpzg4APXDTZb7k';
const SHEET_NAME = 'Xbox';
const HIDDEN_RELEASE_AND_PRICE_ID = '9p181zd79kg5';
const MARKET = 'DE';       // DE = preturi in EUR
const LANGUAGES = 'en-us';
const SLEEP_MS = 1200;
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const NEW_ONLY = process.env.NEW_ONLY === '1';  // 1 = proceseaza doar randuri fara 'name'

function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchGame(id) {
  const url = `https://displaycatalog.mp.microsoft.com/v7.0/products/${encodeURIComponent(id)}?market=${MARKET}&languages=${LANGUAGES}&fieldsTemplate=Details`;
  let js = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'MS-CV': 'DGU1mcuYo0WMMp+F.1' } });
      if (res.status === 200) { js = await res.json(); break; }
      if (res.status === 429 || res.status === 503) { await sleep(2500 * (attempt + 1)); continue; }
      if (res.status === 404) return null;
      await sleep(1500 * (attempt + 1));
    } catch (e) { await sleep(2000 * (attempt + 1)); }
  }
  if (!js || !js.Product) return null;
  const P = js.Product;

  const loc = (P.LocalizedProperties && P.LocalizedProperties[0]) ? P.LocalizedProperties[0] : {};
  const name = loc.ProductTitle || '';
  const publisher = loc.PublisherName || '';
  let developer = loc.DeveloperName || '';
  if (!developer) developer = publisher;

  let icon = '';
  if (Array.isArray(loc.Images)) {
    const byPurpose = {};
    loc.Images.forEach(im => { if (im.ImagePurpose && !byPurpose[im.ImagePurpose]) byPurpose[im.ImagePurpose] = im.Uri; });
    const pick = byPurpose['Poster'] || byPurpose['BoxArt'] || byPurpose['Tile'] || byPurpose['Logo'] || '';
    if (pick) icon = (pick.indexOf('//') === 0) ? ('https:' + pick) : pick;
  }

  const mp = (P.MarketProperties && P.MarketProperties[0]) ? P.MarketProperties[0] : {};
  const releaseIso = mp.OriginalReleaseDate ? String(mp.OriginalReleaseDate).substring(0, 10) : '';
  const ageRating = (typeof mp.MinimumUserAge === 'number') ? ('PEGI ' + mp.MinimumUserAge) : '';

  let rating = '', ratingCount = '';
  if (Array.isArray(mp.UsageData)) {
    const all = mp.UsageData.find(u => u.AggregateTimeSpan === 'AllTime');
    if (all) {
      rating = (typeof all.AverageRating === 'number') ? Math.round(all.AverageRating * 10) / 10 : '';
      ratingCount = (typeof all.RatingCount === 'number') ? all.RatingCount : '';
    }
  }
  if (ratingCount === 0) { rating = ''; ratingCount = ''; }

  const props = P.Properties || {};
  const category = props.Category || (Array.isArray(props.Categories) ? props.Categories.join(', ') : '');

  const gens = props.XboxConsoleGenCompatible || props.XboxConsoleGenOptimized || [];
  const platList = [];
  if (gens.indexOf('ConsoleGen8') !== -1) platList.push('Xbox One');
  if (gens.indexOf('ConsoleGen9') !== -1) platList.push('Xbox Series X|S');
  const platforms = platList.length ? platList.join(', ') : 'Xbox';

  // PRET: cautam availability cu EUR real + actiune Purchase
  let priceCurrent = '', isFree = '';
  const skus = P.DisplaySkuAvailabilities || [];
  let bestPrice = null;
  for (const skuWrap of skus) {
    const avails = skuWrap.Availabilities || [];
    for (const av of avails) {
      const pr = av.OrderManagementData && av.OrderManagementData.Price;
      if (!pr) continue;
      if (pr.CurrencyCode === 'EUR' && typeof pr.ListPrice === 'number') {
        const canBuy = Array.isArray(av.Actions) && av.Actions.indexOf('Purchase') !== -1;
        if (bestPrice === null || canBuy) { bestPrice = pr.ListPrice; if (canBuy) break; }
      }
    }
    if (bestPrice !== null) break;
  }
  if (bestPrice !== null) {
    if (bestPrice === 0) { priceCurrent = 'Free'; isFree = 'TRUE'; }
    else priceCurrent = formatEur(bestPrice);
  }

  const out = {
    name, developer, publisher,
    release_date: releaseIso,
    category, platforms, age_rating: ageRating,
    icon,
    url: 'https://www.microsoft.com/store/productId/' + id,
  };
  if (priceCurrent !== '') { out.price = priceCurrent; out.is_free = isFree || 'FALSE'; }
  if (rating !== '') out.rating = rating;
  if (ratingCount !== '') out.rating_count = ratingCount;
  return out;
}

function formatEur(amount) {
  const n = Math.round(amount * 100) / 100;
  const p = n.toFixed(2).split('.');
  return p[0] + ',' + p[1] + ' €';
}

async function main() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const read = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET_NAME });
  const rows = read.data.values || [];
  if (rows.length < 2) { console.log('Fila goala.'); return; }

  const header = rows[0].map(h => String(h).trim());
  const col = {}; header.forEach((h, i) => { if (h) col[h] = i; });
  if (col['store_id'] === undefined) { console.error('Nu gasesc coloana store_id'); process.exit(1); }

  const updates = [];
  let processed = 0, failed = 0;
  const now = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });

  for (let r = 1; r < rows.length; r++) {
    if (LIMIT > 0 && processed >= LIMIT) break;
    const id = String(rows[r][col['store_id']] || '').trim();
    if (!/^[A-Za-z0-9]{10,14}$/.test(id)) continue;

    if (NEW_ONLY && col['name'] !== undefined && String(rows[r][col['name']]||'').trim() !== '') continue;
    console.log(`[${r}] ${id} ...`);
    const data = await fetchGame(id);
    if (id.toLowerCase() === HIDDEN_RELEASE_AND_PRICE_ID) {
      for (const key of ['release_date', 'price']) {
        if (col[key] !== undefined) {
          updates.push({ range: `${SHEET_NAME}!${colLetter(col[key])}${r + 1}`, values: [['']] });
        }
        if (data) delete data[key];
      }
    }

    if (data) {
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
  while (idx > 0) { const m = (idx - 1) % 26; s = String.fromCharCode(65 + m) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}

main().catch(e => { console.error(e); process.exit(1); });
