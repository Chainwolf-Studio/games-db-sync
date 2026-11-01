/**
 * DIAGNOSTIC — cauta linkuri social media in pagina Steam a unui joc.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function main(){
  // Folosim un joc cu social media cunoscut. age check bypass cu birthtime cookie.
  const appid = '1245620'; // Elden Ring - are social
  const url = `https://store.steampowered.com/app/${appid}/`;
  console.log('Testez:', url);

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Cookie': 'birthtime=283996801; mature_content=1; wants_mature_content=1' },
    redirect: 'follow'
  });
  console.log('HTTP:', res.status);
  const html = await res.text();
  console.log('Lungime:', html.length);

  // Cauta domenii social in HTML
  const patterns = {
    'twitter/x': /(?:twitter\.com|x\.com)\/[A-Za-z0-9_]+/gi,
    'instagram': /instagram\.com\/[A-Za-z0-9_.]+/gi,
    'youtube': /youtube\.com\/(?:channel\/|c\/|user\/|@)[A-Za-z0-9_-]+/gi,
    'discord': /discord\.(?:gg|com\/invite)\/[A-Za-z0-9]+/gi,
    'bluesky': /bsky\.app\/profile\/[A-Za-z0-9_.-]+/gi,
    'facebook': /facebook\.com\/[A-Za-z0-9_.]+/gi,
  };
  for (const [name, re] of Object.entries(patterns)){
    const matches = [...new Set((html.match(re)||[]))];
    console.log(`${name}: ${matches.length ? matches.slice(0,3).join(', ') : 'NIMIC'}`);
  }

  // Sectiunea de linkuri oficiale apare adesea sub "Visit the website"
  console.log('Contine "Visit the website":', html.indexOf('Visit the') !== -1);
  console.log('Contine "apphub_OtherSiteInfo":', html.indexOf('apphub_OtherSiteInfo') !== -1);
  console.log('Contine "age gate" (varsta):', /agegate|app_agegate/i.test(html));

  // Context in jurul linkurilor oficiale
  const idx = html.indexOf('apphub_OtherSiteInfo');
  if (idx !== -1){ console.log('--- context linkuri (400) ---'); console.log(html.substring(idx, idx+400)); }
}
main().catch(e=>console.log('EROARE:', e.message));
