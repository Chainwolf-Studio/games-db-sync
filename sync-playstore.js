/**
 * Sincronizare Play Store -> Google Sheets, rulata pe GitHub Actions.
 *
 * Citeste package-urile din coloana "package_id" a filei PlayStore,
 * extrage datele cu google-play-scraper, si le scrie inapoi in sheet.
 *
 * Autentificare: service account (secret GOOGLE_CREDENTIALS in GitHub).
 */

import gplay from 'google-play-scraper';
import { google } from 'googleapis';

// ---- Config ----
const SPREADSHEET_ID = '1BSMwXovXJxuX8XyfQA5kxZJPT54Kgkpzg4APXDTZb7k';
const SHEET_NAME = 'PlayStore';
const COUNTRY = 'de'; // Piata Google Play cu preturi in EUR
const LANG = 'en';
const SLEEP_MS = 1500;        // pauza intre jocuri (bland cu Google)
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const NEW_ONLY = process.env.NEW_ONLY === '1';  // 1 = proceseaza doar randuri fara 'name' // 0 = toate; altfel doar primele N (pentru test)

// ---- Auth Google Sheets ----
function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Extrage package id din URL sau accepta direct package id
function extractPkg(raw) {
  raw = String(raw || '').trim();
  const m = raw.match(/[?&]id=([a-zA-Z0-9._]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9._]+$/.test(raw) && raw.includes('.')) return raw;
  return null;
}

async function fetchGame(pkg) {
  try {
    const g = await gplay.app({ appId: pkg, lang: LANG, country: COUNTRY });
    return {
      name: g.title || '',
      developer: g.developer || '',
      price: g.free ? 'Free' : (g.currency === 'EUR' && Number.isFinite(g.price)
        ? `${g.price.toFixed(2).replace('.', ',')} €` : ''),
      is_free: !!g.free,
      rating: (typeof g.score === 'number') ? Math.round(g.score * 10) / 10 : '',
      rating_count: (typeof g.ratings === 'number') ? g.ratings : '',
      installs: g.installs || '',
      min_installs: (typeof g.minInstalls === 'number') ? g.minInstalls : '',
      category: g.genre || '',
      release_date: g.released || '',
      icon: g.icon || '',
      in_app_purchases: g.offersIAP ? 'TRUE' : 'FALSE',
      contains_ads: g.adSupported ? 'TRUE' : 'FALSE',
      version: g.version || '',
      url: g.url || `https://play.google.com/store/apps/details?id=${pkg}`,
    };
  } catch (e) {
    return null; // joc negasit / eroare
  }
}

async function main() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // 1) Citeste tot tab-ul PlayStore
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}`,
  });
  const rows = read.data.values || [];
  if (rows.length < 2) { console.log('Fila goala sau fara date.'); return; }

  const header = rows[0].map(h => String(h).trim());
  const col = {};
  header.forEach((h, i) => { if (h) col[h] = i; });

  if (col['package_id'] === undefined) { console.error('Nu gasesc coloana package_id'); process.exit(1); }

  // Pregatim actualizarile (batch, ca sa scriem eficient)
  const updates = [];
  let processed = 0, failed = 0;

  const now = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });

  for (let r = 1; r < rows.length; r++) {
    if (LIMIT > 0 && processed >= LIMIT) break;

    const raw = rows[r][col['package_id']] || '';
    const pkg = extractPkg(raw);
    if (!pkg) continue;

    if (NEW_ONLY && col['name'] !== undefined && String(rows[r][col['name']]||'').trim() !== '') continue;
    console.log(`[${r}] ${pkg} ...`);
    const data = await fetchGame(pkg);

    if (data) {
      // Pentru fiecare camp recunoscut care are coloana, pregatim update-ul
      Object.keys(data).forEach(key => {
        if (col[key] === undefined) return;
        const colLetter = columnLetter(col[key]);
        updates.push({
          range: `${SHEET_NAME}!${colLetter}${r + 1}`,
          values: [[data[key]]],
        });
      });
      if (col['sync_status'] !== undefined) {
        updates.push({ range: `${SHEET_NAME}!${columnLetter(col['sync_status'])}${r + 1}`, values: [['OK']] });
      }
      if (col['last_synced'] !== undefined) {
        updates.push({ range: `${SHEET_NAME}!${columnLetter(col['last_synced'])}${r + 1}`, values: [[now]] });
      }
      processed++;
      console.log(`    OK: ${data.name}`);
    } else {
      failed++;
      if (col['sync_status'] !== undefined) {
        updates.push({ range: `${SHEET_NAME}!${columnLetter(col['sync_status'])}${r + 1}`, values: [['Not found']] });
      }
      console.log(`    esuat`);
    }

    await sleep(SLEEP_MS);
  }

  // 2) Scrie toate actualizarile dintr-o data (batch)
  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
    });
  }

  console.log(`\nGata. Procesate: ${processed}, esuate: ${failed}, celule actualizate: ${updates.length}`);
}

// Converteste index coloana (0-based) in litera A, B, ... Z, AA, AB...
function columnLetter(idx) {
  let s = '';
  idx = idx + 1;
  while (idx > 0) {
    const m = (idx - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}

main().catch(e => { console.error(e); process.exit(1); });
