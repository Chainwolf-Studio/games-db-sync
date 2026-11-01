/**
 * Modul social media pentru Steam.
 * Extrage prezenta (TRUE/FALSE) din HTML-ul paginii Steam + numere via API.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Extrage handle-urile social din HTML-ul paginii Steam
export function extractSocial(html) {
  const result = {
    has_website: false, has_twitter: false, has_instagram: false,
    has_youtube: false, has_discord: false, has_bluesky: false, has_facebook: false, has_tiktok: false, has_twitch: false,
    _twitter: null, _instagram: null, _youtube: null, _discord: null, _bluesky: null, _website: null, _facebook: null, _tiktok: null, _twitch: null
  };
  if (!html) return result;

  // Website: linkul "Visit the website" din apphub
  const web = html.match(/href="(https?:\/\/[^"]+)"[^>]*>\s*<span>Visit the website/i)
           || html.match(/class="[^"]*apphub_Card[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i);
  // mai simplu: cautam linkul oficial de website (steamcommunity linkout)
  const webLink = html.match(/steampowered\.com\/linkfilter\/\?url=(https?[^"'&]+)/i);
  if (webLink) { result.has_website = true; result._website = decodeURIComponent(webLink[1]); }

  const grab = (re) => { const m = html.match(re); return m ? m[0] : null; };

  const tw = grab(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{2,30})/i);
  if (tw) { const h = tw.split('/').pop(); if (!['home','share','intent','i'].includes(h.toLowerCase())) { result.has_twitter = true; result._twitter = h; } }

  const ig = grab(/instagram\.com\/([A-Za-z0-9_.]{2,40})/i);
  if (ig) { const h = ig.split('/').pop(); if (!['p','explore','accounts'].includes(h.toLowerCase())) { result.has_instagram = true; result._instagram = h; } }

  const yt = grab(/youtube\.com\/(?:channel\/|c\/|user\/|@)([A-Za-z0-9_-]{2,40})/i);
  if (yt) { result.has_youtube = true; result._youtube = yt; }

  const dc = grab(/discord\.(?:gg|com\/invite)\/([A-Za-z0-9]{4,20})/i);
  if (dc) { result.has_discord = true; result._discord = dc.split('/').pop(); }

  const bs = grab(/bsky\.app\/profile\/([A-Za-z0-9_.-]{2,60})/i);
  if (bs) { result.has_bluesky = true; result._bluesky = bs.split('/').pop(); }

  const fb = grab(/facebook\.com\/([A-Za-z0-9_.-]{2,50})/i);
  if (fb) { const h = fb.split('/').pop(); if (!['sharer','sharer.php','dialog','plugins','tr'].includes(h.toLowerCase())) { result.has_facebook = true; result._facebook = h; } }

  const tk = grab(/tiktok\.com\/@([A-Za-z0-9_.]{2,30})/i);
  if (tk) { result.has_tiktok = true; result._tiktok = tk.split('@').pop(); }

  const tv = grab(/twitch\.tv\/([A-Za-z0-9_]{2,30})/i);
  if (tv) { const h = tv.split('/').pop(); if (!['directory','p','videos'].includes(h.toLowerCase())) { result.has_twitch = true; result._twitch = h; } }

  return result;
}

// Numar followeri Bluesky (API public, fara cheie)
export async function blueskyFollowers(handle) {
  if (!handle) return 0;
  try {
    const url = 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=' + encodeURIComponent(handle);
    const res = await fetch(url);
    if (res.ok) { const j = await res.json(); return (typeof j.followersCount === 'number') ? j.followersCount : 0; }
  } catch (e) {}
  return 0;
}

// Numar membri Discord (widget public, daca e activat)
export async function discordMembers(inviteCode) {
  if (!inviteCode) return 0;
  try {
    // Invite-ul ne da guild id; apoi widget-ul da numarul
    const inv = await fetch('https://discord.com/api/v10/invites/' + encodeURIComponent(inviteCode) + '?with_counts=true');
    if (inv.ok) { const j = await inv.json(); if (typeof j.approximate_member_count === 'number') return j.approximate_member_count; }
  } catch (e) {}
  return 0;
}

// Numar subscriberi YouTube (necesita YOUTUBE_API_KEY)
export async function youtubeSubscribers(channelRef) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || !channelRef) return 0;
  try {
    let channelId = null;
    // channelRef poate fi: channel/UCxxx, @handle, c/nume, user/nume
    if (channelRef.startsWith('channel/')) {
      channelId = channelRef.split('/')[1];
    } else {
      // Pentru @handle sau nume, cautam canalul
      let q = channelRef.replace(/^(c\/|user\/|@)/, '');
      const search = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(q)}&key=${key}`);
      if (search.ok) { const sj = await search.json(); if (sj.items && sj.items.length) channelId = sj.items[0].snippet.channelId; }
    }
    if (!channelId) return 0;
    const stats = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${key}`);
    if (stats.ok) { const st = await stats.json(); if (st.items && st.items.length) return parseInt(st.items[0].statistics.subscriberCount || '0', 10); }
  } catch (e) {}
  return 0;
}

// Numar urmaritori Twitch (necesita TWITCH_CLIENT_ID + TWITCH_SECRET)
let _twitchToken = null;
async function getTwitchToken() {
  if (_twitchToken) return _twitchToken;
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_SECRET;
  if (!id || !secret) return null;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${id}&client_secret=${secret}&grant_type=client_credentials`
    });
    if (res.ok) { const j = await res.json(); _twitchToken = j.access_token; return _twitchToken; }
  } catch (e) {}
  return null;
}

export async function twitchFollowers(login) {
  if (!login) return 0;
  const id = process.env.TWITCH_CLIENT_ID;
  const token = await getTwitchToken();
  if (!id || !token) return 0;
  try {
    // 1) login -> user id
    const u = await fetch('https://api.twitch.tv/helix/users?login=' + encodeURIComponent(login), {
      headers: { 'Client-ID': id, 'Authorization': 'Bearer ' + token }
    });
    if (!u.ok) return 0;
    const uj = await u.json();
    if (!uj.data || !uj.data.length) return 0;
    const userId = uj.data[0].id;
    // 2) numar urmaritori
    const f = await fetch('https://api.twitch.tv/helix/channels/followers?broadcaster_id=' + userId, {
      headers: { 'Client-ID': id, 'Authorization': 'Bearer ' + token }
    });
    if (f.ok) { const fj = await f.json(); if (typeof fj.total === 'number') return fj.total; }
  } catch (e) {}
  return 0;
}
