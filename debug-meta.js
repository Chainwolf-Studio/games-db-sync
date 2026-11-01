/**
 * DIAGNOSTIC Meta — verifica daca paginile se incarca din GitHub.
 * Ruleaza o data, uita-te la log.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function main() {
  const testUrl = 'https://www.meta.com/experiences/the-secret-of-retropolis/4148745208478773/';
  console.log('Testez:', testUrl);

  try {
    const res = await fetch(testUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    console.log('HTTP status:', res.status);
    console.log('URL final (dupa redirect):', res.url);
    const html = await res.text();
    console.log('Lungime HTML:', html.length);
    console.log('Contine "Retropolis":', html.indexOf('Retropolis') !== -1);
    console.log('Contine "aggregateRating":', html.indexOf('aggregateRating') !== -1);
    console.log('Contine "application/ld+json":', html.indexOf('application/ld+json') !== -1);
    console.log('Contine "cf_challenge" sau "captcha":', /cf_challenge|captcha|Access Denied|blocked/i.test(html));
    console.log('--- Primele 400 caractere ---');
    console.log(html.substring(0, 400));
  } catch (e) {
    console.log('EROARE fetch:', e.message);
  }
}
main();
