/**
 * Sincronizare Steam -> Google Sheets (GitHub Actions).
 *
 * - appdetails (regiuni euro FR/DE/ES) + conversie valutara pentru non-euro
 * - Recenzii prin NOUL API: IUserReviewsService/GetAppReviews (dupa 22 oct 2026)
 *   doar cumparatori Steam, languages=all pentru total corect
 * - Followers din Steam Community XML
 * - NU marcheaza niciodata "Removed" automat (doar semnaleaza verificare manuala)
 * - release_status, platforme, genuri, pret cu discount
 */

import { google } from 'googleapis';
import { extractSocial, blueskyFollowers, discordMembers, youtubeSubscribers, twitchFollowers } from './social-media.js';

const SPREADSHEET_ID = '1BSMwXovXJxuX8XyfQA5kxZJPT54Kgkpzg4APXDTZb7k';
const SHEET_NAME = 'Steam';
const LANG = 'english';
const EURO_REGIONS = ['FR', 'DE', 'ES'];
const NONEURO_REGIONS = ['US', 'GB'];
const REGION_CURRENCY = { US: 'USD', GB: 'GBP' };
const SLEEP_MS = 2500;         // bland cu Akamai
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const SOCIAL_ONLY = process.argv.includes('--social-only');
const NEW_ONLY = process.env.NEW_ONLY === '1';  // 1 = proceseaza doar randuri fara 'name'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const CATEGORY_MAP = {
  'Single-player':'single_player','Multi-player':'multiplayer','PvP':'multiplayer',
  'Online PvP':'online_pvp','Shared/Split Screen PvP':'split_pvp','Co-op':'online_coop',
  'Online Co-op':'online_coop','Shared/Split Screen Co-op':'split_coop','MMO':'mmo',
  'Cross-Platform Multiplayer':'cross_platform'
};
const BOOLEAN_FIELDS = ['demo_available','is_free','dlc_available','single_player','multiplayer','online_pvp','split_pvp','online_coop','split_coop','mmo','cross_platform','has_website','has_twitter','has_instagram','has_youtube','has_discord','has_bluesky','has_facebook','has_tiktok','has_twitch'];

function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let _rates = null;
async function getRates() {
  if (_rates) return _rates;
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD,GBP');
    if (res.ok) { const j = await res.json(); _rates = { USD: j.rates.USD?1/j.rates.USD:0.92, GBP: j.rates.GBP?1/j.rates.GBP:1.17 }; return _rates; }
  } catch(e){}
  _rates = { USD:0.92, GBP:1.17 }; return _rates;
}
function formatEur(a){ const n=Math.round(a*100)/100; const p=n.toFixed(2).split('.'); return p[0]+','+p[1]+' €'; }

async function fetchJson(url){
  try { const res = await fetch(url, { headers:{'Accept':'application/json'} }); if(res.status!==200) return {code:res.status,json:null}; return {code:200,json:await res.json()}; }
  catch(e){ return {code:0,json:null}; }
}

// NOUL API de recenzii (dupa 22 oct 2026)
async function fetchReviews(appid, isFree){
  const input = {
    appid: Number(appid),
    filter: 1,
    languages: ['all'],
    purchase_type: isFree ? 1 : 0,
    num_per_page: 1,
  };
  const url = 'https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/?input_json=' + encodeURIComponent(JSON.stringify(input));
  for (let a=0; a<=2; a++){
    const r = await fetchJson(url);
    const summary = r.json?.response?.query_summary;
    if (Number.isInteger(summary?.total_reviews) &&
        (summary.total_reviews === 0 || Number.isInteger(summary.total_positive))) return summary;
    if (a === 2) console.warn(`    Recenzii indisponibile pentru ${appid} (HTTP ${r.code})`);
    else await sleep(1200 * (a + 1));
  }
  return null;
}

async function fetchFollowers(appid){
  const url = 'https://steamcommunity.com/games/'+appid+'/memberslistxml/?xml=1';
  for (let a=0; a<=2; a++){
    try {
      const res = await fetch(url, { headers:{'User-Agent':UA}, redirect:'follow' });
      if (res.status===200){ const xml=await res.text(); const m=xml.match(/<memberCount>(\d+)<\/memberCount>/); if(m) return Number(m[1]); return null; }
      if (res.status===403||res.status===429){ await sleep(2500*(a+1)); continue; }
      await sleep(1000*(a+1));
    } catch(e){ await sleep(1500*(a+1)); }
  }
  return null;
}


async function fetchSteamPageHtml(appid){
  try {
    const res = await fetch(`https://store.steampowered.com/app/${appid}/`, {
      headers: { 'User-Agent': UA, 'Cookie': 'birthtime=283996801; mature_content=1; wants_mature_content=1' },
      redirect: 'follow'
    });
    if (res.status === 200) return await res.text();
  } catch(e){}
  return null;
}

async function fetchSocial(appid){
  const pageHtml = await fetchSteamPageHtml(appid);
  if (pageHtml === null) return null;
  const social = extractSocial(pageHtml);
  const youtube_subscribers = await youtubeSubscribers(social._youtube);
  const bluesky_followers = await blueskyFollowers(social._bluesky);
  const discord_members = await discordMembers(social._discord);
  const twitch_followers = await twitchFollowers(social._twitch);

  return {
    has_website: social.has_website, has_twitter: social.has_twitter,
    has_instagram: social.has_instagram, has_youtube: social.has_youtube,
    has_discord: social.has_discord, has_bluesky: social.has_bluesky, has_facebook: social.has_facebook,
    has_tiktok: social.has_tiktok, has_twitch: social.has_twitch,
    youtube_subscribers: youtube_subscribers,
    bluesky_followers: bluesky_followers,
    discord_members: discord_members,
    twitter_followers: 0,
    instagram_followers: 0,
    facebook_followers: 0,
    tiktok_followers: 0,
    twitch_followers: twitch_followers
  };
}

async function fetchGame(appid){
  let g=null, usedRegion='', nonEuroRegion='';

  for (const cc of EURO_REGIONS){
    const r = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=${LANG}`);
    if (r.json && r.json[appid] && r.json[appid].success && r.json[appid].data){ g=r.json[appid].data; usedRegion=cc; break; }
    await sleep(400);
  }
  if (!g){
    for (const cc of NONEURO_REGIONS){
      const r = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=${LANG}`);
      if (r.json && r.json[appid] && r.json[appid].success && r.json[appid].data){ g=r.json[appid].data; nonEuroRegion=cc; usedRegion=cc; break; }
      await sleep(400);
    }
  }
  if (!g) return { __notfound:true };

  const comingSoon = !!g.release_date?.coming_soon;
  const isFree = !comingSoon && !!g.is_free;
  const summary = await fetchReviews(appid, isFree);
  const followers = await fetchFollowers(appid);

  const catNames = (g.categories||[]).map(c=>c.description);
  const features = {};
  Object.keys(CATEGORY_MAP).forEach(sn=>{ if(catNames.indexOf(sn)!==-1) features[CATEGORY_MAP[sn]]=true; });

  // PRET
  const isEuro = EURO_REGIONS.includes(usedRegion);
  let priceCurrent='', priceOriginal='', priceDiscount=0, priceSource='', havePrice=false;
  if (isFree){ priceCurrent='Free'; priceSource='free'; havePrice=true; }
  else if (g.price_overview && (!comingSoon || g.price_overview.final > 0)){
    const po=g.price_overview;
    if (nonEuroRegion){
      const cur=REGION_CURRENCY[nonEuroRegion]||'USD'; const rate=(await getRates())[cur];
      if (rate && po.final){ priceCurrent=formatEur((po.final/100)*rate); priceDiscount=parseInt(po.discount_percent||0,10); if(priceDiscount>0&&po.initial) priceOriginal=formatEur((po.initial/100)*rate); priceSource='converted '+cur; havePrice=true; }
    } else {
      priceCurrent=po.final_formatted||''; priceDiscount=parseInt(po.discount_percent||0,10); if(priceDiscount>0&&po.initial_formatted) priceOriginal=po.initial_formatted; priceSource='EUR'; havePrice=(priceCurrent!=='');
    }
  }
  const availability = (g.is_free || !!g.price_overview) ? 'Available' : 'Unavailable';

  let releaseText = (g.release_date && g.release_date.date) ? g.release_date.date : '';
  if (comingSoon && !releaseText) releaseText='Coming soon';
  if (!releaseText) releaseText='TBA';

  const plats=[];
  if (g.platforms){ if(g.platforms.windows)plats.push('Windows'); if(g.platforms.mac)plats.push('macOS'); if(g.platforms.linux)plats.push('Linux'); }

  const out = {
    __notfound:false,
    availability,
    name: g.name||'',
    capsule_image: g.header_image||'',
    store_url: `https://store.steampowered.com/app/${appid}/`,
    developer: (g.developers||[]).join(', '),
    publisher: (g.publishers||[]).join(', '),
    release_date: releaseText,
    release_status: comingSoon ? 'Coming Soon' : ((g.genres||[]).some(x=>x.description==='Early Access') ? 'Early Access' : 'Full Release'),
    demo_available: !!(g.demos && g.demos.length),
    is_free: isFree,
    platforms: plats.join(', '),
    genres: (g.genres||[]).map(x=>x.description).join(', '),
    dlc_available: !!(g.dlc && g.dlc.length),
    achievements_count: (g.achievements&&g.achievements.total)?g.achievements.total:0,
    short_description: g.short_description||'',
    price_region: usedRegion,
    single_player:features.single_player||false, multiplayer:features.multiplayer||false,
    online_pvp:features.online_pvp||false, split_pvp:features.split_pvp||false,
    online_coop:features.online_coop||false, split_coop:features.split_coop||false,
    mmo:features.mmo||false, cross_platform:features.cross_platform||false,

  };
  if (havePrice){ out.price_current=priceCurrent; out.price_original=priceOriginal; out.price_discount=priceDiscount; out.price_source=priceSource; }
  else if (comingSoon){
    // Explicitly clear any stale price already stored in Sheets.
    out.price_current = '';
    out.price_original = '';
    out.price_discount = '';
    out.price_source = '';
  }
  if (summary){
    const tot=Number(summary.total_reviews||0), pos=Number(summary.total_positive||0);
    out.review_rating = summary.review_score_desc||'';
    out.review_count = tot;
    out.review_positive_pct = tot>0 ? Math.round(pos*100/tot) : '';
  }
  if (followers!==null) out.followers = followers;
  return out;
}

async function main(){
  const auth=getAuth(); const sheets=google.sheets({version:'v4',auth});
  const read=await sheets.spreadsheets.values.get({spreadsheetId:SPREADSHEET_ID,range:SHEET_NAME});
  const rows=read.data.values||[];
  if (rows.length<2){ console.log('Fila goala.'); return; }
  const header=rows[0].map(h=>String(h).trim());
  const col={}; header.forEach((h,i)=>{ if(h)col[h]=i; });
  if (col['appid']===undefined){ console.error('Nu gasesc coloana appid'); process.exit(1); }

  const updates=[]; let processed=0, notfound=0;
  const now=new Date().toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'});

  for (let r=1; r<rows.length; r++){
    if (LIMIT>0 && processed>=LIMIT) break;
    const appid=String(rows[r][col['appid']]||'').trim();
    if (!/^\d+$/.test(appid)) continue;

    if (NEW_ONLY && col['name'] !== undefined && String(rows[r][col['name']]||'').trim() !== '') continue;
    console.log(`[${r}] ${appid} ...`);
    const data = SOCIAL_ONLY ? await fetchSocial(appid) : await fetchGame(appid);

    if (data && !data.__notfound){
      Object.keys(data).forEach(key=>{
        if (key==='__notfound') return;
        if (col[key]===undefined) return;
        let val=data[key];
        if (BOOLEAN_FIELDS.includes(key)) val = val?'TRUE':'FALSE';
        updates.push({range:`${SHEET_NAME}!${colLetter(col[key])}${r+1}`, values:[[val]]});
      });
      if (!SOCIAL_ONLY && col['sync_status']!==undefined){
        const note = (data.price_source && data.price_source.indexOf('converted')===0) ? 'OK — pret convertit' : 'OK';
        updates.push({range:`${SHEET_NAME}!${colLetter(col['sync_status'])}${r+1}`, values:[[note]]});
      }
      if (!SOCIAL_ONLY && col['last_synced']!==undefined) updates.push({range:`${SHEET_NAME}!${colLetter(col['last_synced'])}${r+1}`, values:[[now]]});
      processed++;
      console.log(`    OK: ${data.name ?? appid}`);
    } else {
      // NU marcam Removed — doar semnalam verificare manuala, FARA sa atingem availability
      notfound++;
      if (!SOCIAL_ONLY && col['sync_status']!==undefined) updates.push({range:`${SHEET_NAME}!${colLetter(col['sync_status'])}${r+1}`, values:[['Nu s-a gasit — VERIFICA MANUAL']]});
      console.log('    nu s-a gasit');
    }
    await sleep(SLEEP_MS);
  }

  if (updates.length){
    await sheets.spreadsheets.values.batchUpdate({spreadsheetId:SPREADSHEET_ID, requestBody:{valueInputOption:'USER_ENTERED', data:updates}});
  }
  console.log(`\nGata. Procesate: ${processed}, negasite: ${notfound}, celule: ${updates.length}`);
}

function colLetter(idx){ let s=''; idx=idx+1; while(idx>0){ const m=(idx-1)%26; s=String.fromCharCode(65+m)+s; idx=Math.floor((idx-1)/26); } return s; }

main().catch(e=>{ console.error(e); process.exit(1); });
