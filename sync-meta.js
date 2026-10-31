/**
 * Sincronizare Meta Quest -> Google Sheets (GitHub Actions).
 * Scraping pagina Meta (JSON-LD @graph).
 * ATENTIE: NU scrie release_date (completata manual de utilizator).
 */

import { google } from 'googleapis';

const SPREADSHEET_ID = '1BSMwXovXJxuX8XyfQA5kxZJPT54Kgkpzg4APXDTZb7k';
const SHEET_NAME = 'Meta';
const SLEEP_MS = 2000;
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Coloane pe care NU le scriem niciodata (completate manual)
const PROTECTED_COLS = ['release_date'];

function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function formatEur(amount) {
  const n = Math.round(amount * 100) / 100;
  const p = n.toFixed(2).split('.');
  return p[0] + ',' + p[1] + ' €';
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { out.push(JSON.parse(m[1].trim())); } catch (e) {}
  }
  return out;
}

async function fetchGame(url) {
  let html = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (res.status === 200) { html = await res.text(); break; }
      if (res.status === 429 || res.status === 503 || res.status === 403) { await sleep(3000 * (attempt + 1)); continue; }
      await sleep(1500 * (attempt + 1));
    } catch (e) { await sleep(2000 * (attempt + 1)); }
  }
  if (!html) return null;

  const blocks = extractJsonLd(html);
  let allNodes = [];
  for (const b of blocks) {
    if (Array.isArray(b)) allNodes = allNodes.concat(b);
    else if (b['@graph'] && Array.isArray(b['@graph'])) allNodes = allNodes.concat(b['@graph']);
    else allNodes.push(b);
  }
  const byId = {};
  allNodes.forEach(n => { if (n && n['@id']) byId[n['@id']] = n; });

  let product = null;
  for (const n of allNodes) {
    if (!n) continue;
    const t = n['@type']; const types = Array.isArray(t) ? t : [t];
    const isGame = types.some(x => ['VideoGame','Product','SoftwareApplication','Game'].indexOf(x) !== -1);
    if (n.aggregateRating || isGame) { product = n; break; }
  }
  if (!product) return null;

  const out = { name: product.name || '' };

  // Imagine
  function resolveImageRef(ref) {
    if (!ref) return '';
    if (typeof ref === 'string') return ref;
    if (ref.url) return ref.url;
    if (ref.contentUrl) return ref.contentUrl;
    if (ref['@id']) {
      if (/^https?:\/\//.test(ref['@id']) && /\.(webp|jpg|jpeg|png)/i.test(ref['@id'])) return ref['@id'];
      const target = byId[ref['@id']];
      if (target) return target.url || target.contentUrl || (/\.(webp|jpg|jpeg|png)/i.test(ref['@id']) ? ref['@id'] : '');
      if (/\.(webp|jpg|jpeg|png)/i.test(ref['@id'])) return ref['@id'];
    }
    return '';
  }
  function extractImage(img) {
    if (!img) return '';
    if (Array.isArray(img)) { for (const el of img) { const u = resolveImageRef(el); if (u) return u; } return ''; }
    return resolveImageRef(img);
  }
  out.icon = extractImage(product.image);
  if (!out.icon) {
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (og) out.icon = og[1].replace(/&amp;/g, '&');
  }
  if (!out.icon) {
    const cdn = html.match(/https:\/\/[^"'\\]*oculuscdn[^"'\\]*\.webp[^"'\\]*/i);
    if (cdn) out.icon = cdn[0].replace(/&amp;/g, '&');
  }

  // Rating
  if (product.aggregateRating) {
    const ar = product.aggregateRating;
    if (ar.ratingValue !== undefined) out.rating = Math.round(parseFloat(ar.ratingValue) * 10) / 10;
    out.rating_count = ar.ratingCount ? parseInt(ar.ratingCount, 10) : (ar.reviewCount ? parseInt(ar.reviewCount, 10) : '');
  }

  function resolveName(ref) {
    if (!ref) return '';
    if (typeof ref === 'string') return ref;
    if (ref.name) return ref.name;
    if (ref['@id']) {
      const target = byId[ref['@id']];
      if (target && target.name) return target.name;
      const m = String(ref['@id']).match(/\/Organization\/(.+)$/);
      if (m) return decodeURIComponent(m[1]).replace(/\+/g, ' ');
    }
    return '';
  }
  out.publisher = resolveName(product.publisher);
  out.developer = resolveName(product.author) || resolveName(product.creator) || resolveName(product.brand) || out.publisher;

  // Pret -> euro
  if (product.offers) {
    const off = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    if (off) {
      const price = off.price || (off.priceSpecification && off.priceSpecification.price);
      const cur = off.priceCurrency || (off.priceSpecification && off.priceSpecification.priceCurrency) || '';
      if (price !== undefined && price !== null && price !== '') {
        const num = parseFloat(price);
        if (num === 0) out.price = 'Free';
        else if (cur === 'USD') out.price = formatEur(num * 0.92);
        else if (cur === 'GBP') out.price = formatEur(num * 1.17);
        else out.price = formatEur(num);
      }
    }
  }

  // Gen
  if (product.applicationSubCategory) out.genres = Array.isArray(product.applicationSubCategory) ? product.applicationSubCategory.join(', ') : String(product.applicationSubCategory);
  else if (product.genre) out.genres = Array.isArray(product.genre) ? product.genre.join(', ') : String(product.genre);

  // Casti
  if (product.availableOnDevice) {
    const devs = Array.isArray(product.availableOnDevice) ? product.availableOnDevice : [product.availableOnDevice];
    const filtered = devs.filter(d => d && d !== 'Quest');
    out.platforms = (filtered.length ? filtered : devs).join(', ');
  }

  // NU setam release_date — e manuala

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
  if (col['meta_url'] === undefined) { console.error('Nu gasesc coloana meta_url'); process.exit(1); }

  const updates = [];
  let processed = 0, failed = 0;
  const now = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });

  for (let r = 1; r < rows.length; r++) {
    if (LIMIT > 0 && processed >= LIMIT) break;
    let raw = String(rows[r][col['meta_url']] || '').trim();
    let url = raw;
    if (!/^https?:\/\//i.test(raw)) {
      if (/^\d+$/.test(raw)) url = 'https://www.meta.com/experiences/' + raw + '/';
      else continue;
    }

    console.log(`[${r}] ${url} ...`);
    const data = await fetchGame(url);

    if (data && data.name) {
      Object.keys(data).forEach(key => {
        if (col[key] === undefined) return;
        if (PROTECTED_COLS.includes(key)) return; // nu scriem coloane protejate (data manuala)
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
