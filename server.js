/**

- BCHS Eagles Backend — server.js  (v2.0)
- 
- Scrapes MaxPreps for real BCHS schedule, roster, standings, and records.
- Caches everything in memory so the frontend never hits MaxPreps directly.
- 
- LOCAL:   npm install  →  node server.js  →  http://localhost:3001
- RAILWAY: push to GitHub → deploy from Railway (see DEPLOY.md)
  */

const express = require(“express”);
const cors    = require(“cors”);
const https   = require(“https”);
const http    = require(“http”);
const cheerio = require(“cheerio”);

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

/* ── MaxPreps config ─────────────────────────────────────────────────────── */
const MP_BASE = “https://www.maxpreps.com/ca/bakersfield/bakersfield-christian-eagles”;

const SPORT_URLS = {
football:        `${MP_BASE}/football/schedule/`,
basketball:      `${MP_BASE}/basketball/schedule/`,
basketball_g:    `${MP_BASE}/girls-basketball/schedule/`,
baseball:        `${MP_BASE}/baseball/schedule/`,
softball:        `${MP_BASE}/softball/schedule/`,
soccer:          `${MP_BASE}/boys-soccer/schedule/`,
soccer_g:        `${MP_BASE}/girls-soccer/schedule/`,
volleyball:      `${MP_BASE}/girls-volleyball/schedule/`,
volleyball_boys: `${MP_BASE}/boys-volleyball/schedule/`,
beach_vball:     `${MP_BASE}/beach-volleyball/schedule/`,
track:           `${MP_BASE}/boys-track-and-field/schedule/`,
cross_country:   `${MP_BASE}/boys-cross-country/schedule/`,
swimming:        `${MP_BASE}/boys-swimming-diving/schedule/`,
tennis:          `${MP_BASE}/boys-tennis/schedule/`,
wrestling:       `${MP_BASE}/wrestling/schedule/`,
golf:            `${MP_BASE}/boys-golf/schedule/`,
};

const ROSTER_URLS = {
football:   `${MP_BASE}/football/roster/`,
basketball: `${MP_BASE}/basketball/roster/`,
baseball:   `${MP_BASE}/baseball/roster/`,
softball:   `${MP_BASE}/softball/roster/`,
soccer:     `${MP_BASE}/boys-soccer/roster/`,
volleyball: `${MP_BASE}/girls-volleyball/roster/`,
};

const STANDINGS_URL = `${MP_BASE}/basketball/standings/`;
const NEWS_URL      = `${MP_BASE}/`;

/* ── Postseason config — update this when sports enter/exit playoffs ─────── */
// This is what drives the featured card and postseason banner in the app.
// To add a sport: copy one entry and fill in the details.
// To remove: delete the entry when they are eliminated.
const POSTSEASON_SPORTS = {
“Boys Basketball”: {
label:    “CIF State SoCal Regionals”,
sublabel: “Div II · #3 Seed”,
round:    “Quarterfinals”,
color:    “#1B4FD8”,
urgent:   true,
},
// Example — uncomment when Baseball makes playoffs:
// “Baseball”: { label: “CIF CS Playoffs”, sublabel: “Div I”, round: “Quarterfinals”, color: “#22C55E”, urgent: true },
};

// Sports whose season is over — won’t show upcoming games in the schedule
const SEASON_OVER = [
“Football”,
“Girls Basketball”,
“Boys Soccer”,
“Girls Soccer”,
“Girls Volleyball”,
];

/* ── In-memory cache ─────────────────────────────────────────────────────── */
const CACHE = {
schedule:  { data: null, ts: 0 },
standings: { data: null, ts: 0 },
rosters:   { data: {},   ts: 0 },
overview:  { data: null, ts: 0 },
};

const TTL = {
schedule:  5  * 60 * 1000,   // 5 min
standings: 15 * 60 * 1000,   // 15 min
rosters:   60 * 60 * 1000,   // 1 hour
overview:  20 * 60 * 1000,   // 20 min
};

/* ── HTTP fetch helper ───────────────────────────────────────────────────── */
function fetchHTML(url, hops = 0) {
return new Promise((resolve, reject) => {
if (hops > 4) return reject(new Error(“Too many redirects”));
const client = url.startsWith(“https”) ? https : http;
const req = client.get(url, {
headers: {
“User-Agent”:      “Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36”,
“Accept”:          “text/html,application/xhtml+xml,*/*;q=0.9”,
“Accept-Language”: “en-US,en;q=0.9”,
“Cache-Control”:   “no-cache”,
“Referer”:         “https://www.maxpreps.com/”,
},
timeout: 12000,
}, (res) => {
if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
return fetchHTML(res.headers.location, hops + 1).then(resolve).catch(reject);
}
if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
let body = “”;
res.setEncoding(“utf8”);
res.on(“data”, c => body += c);
res.on(“end”, () => resolve(body));
});
req.on(“error”, reject);
req.on(“timeout”, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
});
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function abbreviate(name) {
const clean = name.replace(/\s+(High School|HS|Academy|Christian|Catholic|Prep)$/i, “”).trim();
const words = clean.split(/\s+/);
return (words.length === 1 ? clean.substring(0,4) : words.map(w=>w[0]).join(””)).toUpperCase().substring(0,4);
}

function formatDate(d) {
if (!d) return “TBD”;
try {
const date = new Date(d);
if (isNaN(date)) return String(d);
return date.toLocaleDateString(“en-US”, { weekday:“short”, month:“short”, day:“numeric” });
} catch { return String(d); }
}

function formatStats(s) {
if (!s || typeof s !== “object”) return “—”;
const p = [];
if (s.points    != null) p.push(`${s.points} PPG`);
if (s.assists   != null) p.push(`${s.assists} APG`);
if (s.rebounds  != null) p.push(`${s.rebounds} RPG`);
if (s.yards     != null) p.push(`${s.yards} yds`);
if (s.touchdowns!= null) p.push(`${s.touchdowns} TD`);
if (s.era       != null) p.push(`${s.era} ERA`);
if (s.avg       != null) p.push(`.${String(Math.round(s.avg*1000)).padStart(3,"0")} AVG`);
return p.slice(0,3).join(” · “) || “—”;
}

/* ── Schedule parser ─────────────────────────────────────────────────────── */
function parseSchedule(html, sportName, icon) {
const $ = cheerio.load(html);
const games = [];

// Try Next.js JSON blob first
const nd = $(“script#**NEXT_DATA**”).html();
if (nd) {
try {
const props = JSON.parse(nd)?.props?.pageProps;
const raw = props?.schedule || props?.contests || props?.games
|| props?.team?.schedule || props?.teamData?.schedule;
if (Array.isArray(raw) && raw.length) {
raw.forEach(g => { const p = parseNextGame(g, sportName, icon); if (p) games.push(p); });
console.log(`  ✓ ${sportName}: ${games.length} (JSON)`);
return games;
}
} catch (e) { console.warn(`  ? ${sportName} JSON: ${e.message}`); }
}

// HTML table fallback
$(“table tr, [data-testid=‘schedule-row’]”).each((_, row) => {
const cells = $(row).find(“td”);
if (cells.length < 3) return;
const dateText  = $(cells[0]).text().trim();
const oppText   = $(cells[1]).text().trim();
const scoreText = $(cells[2]).text().trim();
if (!dateText || !oppText) return;
const isHome = !/^[@]/.test(oppText);
const opp    = oppText.replace(/^[@\s]*/, “”).replace(/^(vs.?|at)\s*/i, “”).trim();
const sm = scoreText.match(/([WLT])\s*(\d+)[-–](\d+)/i);
const tm = scoreText.match(/(\d+:\d+\s*[AP]M)/i);
if (opp) games.push({
sport:sportName,icon,opponent:opp,oppAbbr:abbreviate(opp),
date:dateText,time:tm?tm[1]:null,isHome,level:“V”,
result:sm?`${sm[1].toUpperCase()} ${sm[2]}–${sm[3]}`:null,
bcScore:sm?parseInt(sm[2]):null,oppScore:sm?parseInt(sm[3]):null,
});
});

console.log(games.length ? `  ✓ ${sportName}: ${games.length} (HTML)` : `  ✗ ${sportName}: 0 parsed`);
return games;
}

function parseNextGame(g, sportName, icon) {
if (!g) return null;
try {
const opp     = g.opponent?.name || g.opponentName || g.away?.name || String(g.opponent||“Unknown”);
const isHome  = !(g.isAway) && (g.isHome || g.homeAway===“home” || g.location===“home”);
const dateStr = g.date || g.scheduledDate || g.gameDate || g.startDate;
const bs = g.homeScore  ?? g.ourScore  ?? g.teamScore   ?? g.score?.home;
const os = g.awayScore  ?? g.oppScore  ?? g.opponentScore ?? g.score?.away;
const has = bs!=null && os!=null;
const letter = has ? (bs===os?“T”:bs>os?“W”:“L”) : null;
const notes = (g.notes||g.description||g.roundName||g.contestType||””).toLowerCase();
let tag = null;
if (/state|regional/i.test(notes)) tag = “State”;
else if (/cif|playoff/i.test(notes)) tag = “CIF”;
else if (/tourna/i.test(notes)) tag = “***”;
return {
sport:sportName,icon,opponent:opp,oppAbbr:abbreviate(opp),
date:formatDate(dateStr),time:g.time||g.startTime||null,isHome,
level:g.level||g.teamLevel||“V”,tag,
result:has?`${letter} ${bs}–${os}`:null,
bcScore:has?bs:null,oppScore:has?os:null,
};
} catch { return null; }
}

/* ── Roster parser ───────────────────────────────────────────────────────── */
function parseRoster(html) {
const $ = cheerio.load(html);
const players = [];
const nd = $(“script#**NEXT_DATA**”).html();
if (nd) {
try {
const props = JSON.parse(nd)?.props?.pageProps;
const raw = props?.roster||props?.athletes||props?.players||props?.team?.roster;
if (Array.isArray(raw)&&raw.length) {
raw.forEach(p => { if (!p) return; players.push({
num: p.number||p.jerseyNumber||”—”,
name:`${p.firstName||""} ${p.lastName||p.name||""}`.trim(),
pos: p.position||p.primaryPosition||”—”,
yr:  p.grade||p.classYear||”—”,
stat:p.stats?formatStats(p.stats):”—”,
}); });
if (players.length) return players;
}
} catch {}
}
$(“table tr”).each((_,row) => {
const cells=$(row).find(“td”);
if(cells.length<2)return;
const name=$(cells[1]).text().trim();
if(name&&!/^(name|player)/i.test(name))
players.push({num:$(cells[0]).text().trim(),name,pos:$(cells[2])?.text().trim()||”—”,yr:$(cells[3])?.text().trim()||”—”,stat:”—”});
});
return players;
}

/* ── Standings parser ────────────────────────────────────────────────────── */
function parseStandings(html) {
const $ = cheerio.load(html);
const teams = [];
const nd = $(“script#**NEXT_DATA**”).html();
if (nd) {
try {
const props = JSON.parse(nd)?.props?.pageProps;
const raw = props?.standings||props?.leagueStandings||props?.division?.teams;
if (Array.isArray(raw)&&raw.length) {
raw.forEach((t,i)=>teams.push({
rank:i+1,team:t.name||t.teamName||”?”,
w:t.wins||t.overallWins||t.w||0,l:t.losses||t.overallLosses||t.l||0,
us:(t.name||””).toLowerCase().includes(“bakersfield christian”),
}));
if (teams.length) return teams;
}
} catch {}
}
$(“table tr”).each((_,row)=>{
const cells=$(row).find(“td”);
if(cells.length<3)return;
const name=$(cells[0]).text().trim();
if(name&&!/^(team|school)/i.test(name))
teams.push({rank:teams.length+1,team:name,w:parseInt($(cells[1]).text())||0,l:parseInt($(cells[2]).text())||0,us:name.toLowerCase().includes(“bakersfield christian”)});
});
return teams;
}

/* ── Overview parser ─────────────────────────────────────────────────────── */
function parseOverview(html) {
const $ = cheerio.load(html);
const result = { sports:[], recentNews:[] };
const nd = $(“script#**NEXT_DATA**”).html();
if (nd) {
try {
const props = JSON.parse(nd)?.props?.pageProps;
(props?.sports||props?.teams||[]).forEach(s=>{
if(s.sport||s.sportName) result.sports.push({name:s.sport||s.sportName,w:s.wins||0,l:s.losses||0});
});
(props?.news||props?.articles||[]).slice(0,8).forEach(a=>{
result.recentNews.push({id:a.id,title:a.title||a.headline,summary:a.summary||a.excerpt||””,date:formatDate(a.publishDate||a.date),tag:a.sport||“News”,big:false});
});
} catch {}
}
if (!result.recentNews.length) {
$(“h1,h2,h3,.headline”).each((i,el)=>{
if(i>8)return false;
const t=$(el).text().trim();
if(t.length>20&&t.length<200) result.recentNews.push({id:i,title:t,summary:“See MaxPreps for full story.”,date:“Recent”,tag:“News”,big:false});
});
}
return result;
}

/* ── Fetch all schedules ─────────────────────────────────────────────────── */
async function fetchAllSchedules() {
const sports = [
{ key:“football”,        name:“Football”,         icon:“🏈” },
{ key:“basketball”,      name:“Boys Basketball”,  icon:“🏀” },
{ key:“basketball_g”,    name:“Girls Basketball”, icon:“🏀” },
{ key:“baseball”,        name:“Baseball”,         icon:“⚾” },
{ key:“softball”,        name:“Softball”,         icon:“🥎” },
{ key:“soccer”,          name:“Boys Soccer”,      icon:“⚽” },
{ key:“soccer_g”,        name:“Girls Soccer”,     icon:“⚽” },
{ key:“volleyball”,      name:“Girls Volleyball”, icon:“🏐” },
{ key:“volleyball_boys”, name:“Boys Volleyball”,  icon:“🏐” },
{ key:“beach_vball”,     name:“Beach Volleyball”, icon:“🏐” },
{ key:“track”,           name:“Track & Field”,    icon:“🏃” },
{ key:“wrestling”,       name:“Wrestling”,        icon:“🤼” },
{ key:“tennis”,          name:“Tennis”,           icon:“🎾” },
{ key:“swimming”,        name:“Swimming”,         icon:“🏊” },
{ key:“golf”,            name:“Golf”,             icon:“⛳” },
];
const allGames = [];
await Promise.allSettled(sports.map(async s => {
if (!SPORT_URLS[s.key]) return;
try {
const html  = await fetchHTML(SPORT_URLS[s.key]);
const games = parseSchedule(html, s.name, s.icon);
allGames.push(…games);
} catch (e) { console.warn(`  ✗ ${s.name}: ${e.message}`); }
}));
const now = new Date();
return allGames.sort((a,b) => {
const da=new Date(a.date), db=new Date(b.date);
const af=da>=now, bf=db>=now;
if(af&&!bf)return -1; if(!af&&bf)return 1;
return af ? da-db : db-da;
});
}

/* ── Records from schedule ───────────────────────────────────────────────── */
function computeRecords(games) {
const r = {};
games.forEach(g => {
if (!g.result || (g.level!==“V”&&g.level!==“v”&&g.level)) return;
if (!r[g.sport]) r[g.sport]={w:0,l:0,t:0};
const letter=g.result[0];
if(letter===“W”)r[g.sport].w++;
else if(letter===“L”)r[g.sport].l++;
else if(letter===“T”)r[g.sport].t++;
});
return r;
}

/* ── Cache helper ────────────────────────────────────────────────────────── */
async function getCached(key, ttl, fn) {
const now = Date.now();
if (CACHE[key].data && (now-CACHE[key].ts)<ttl) return CACHE[key].data;
try {
const data = await fn();
CACHE[key] = {data,ts:now};
return data;
} catch (err) {
console.error(`[cache] ${key}: ${err.message}`);
if (CACHE[key].data) { console.log(`[stale] ${key}`); return CACHE[key].data; }
throw err;
}
}

/* ═══════════════════════════════════════════════════════════════════════════
REST ENDPOINTS
═══════════════════════════════════════════════════════════════════════════ */

app.get(”/api/health”, (_, res) => res.json({
status:“ok”, version:“2.0.0”, school:“BCHS Eagles”,
postseason:POSTSEASON_SPORTS, seasonOver:SEASON_OVER,
cache:{
schedule:  CACHE.schedule.ts  ? new Date(CACHE.schedule.ts).toISOString()  : null,
standings: CACHE.standings.ts ? new Date(CACHE.standings.ts).toISOString() : null,
},
}));

app.get(”/api/schedule”, async (req, res) => {
try {
const { sport, type=“all” } = req.query;
let games = await getCached(“schedule”, TTL.schedule, fetchAllSchedules);
if (sport) games = games.filter(g=>g.sport.toLowerCase().includes(sport.toLowerCase()));
if (type===“upcoming”) games = games.filter(g=>!g.result);
if (type===“results”)  games = games.filter(g=>!!g.result);
res.json({ success:true, count:games.length, data:games });
} catch (e) { res.status(500).json({success:false,error:e.message}); }
});

app.get(”/api/roster/:sport”, async (req, res) => {
try {
const { sport } = req.params;
if (!ROSTER_URLS[sport]) return res.status(404).json({success:false,error:`Unknown sport: ${sport}`});
if (CACHE.rosters.data?.[sport] && (Date.now()-CACHE.rosters.ts)<TTL.rosters)
return res.json({success:true,sport,data:CACHE.rosters.data[sport]});
const roster = parseRoster(await fetchHTML(ROSTER_URLS[sport]));
if (!CACHE.rosters.data) CACHE.rosters.data={};
CACHE.rosters.data[sport]=roster; CACHE.rosters.ts=Date.now();
res.json({success:true,sport,count:roster.length,data:roster});
} catch (e) { res.status(500).json({success:false,error:e.message}); }
});

app.get(”/api/standings”, async (req, res) => {
try {
const data = await getCached(“standings”, TTL.standings, () => fetchHTML(STANDINGS_URL).then(parseStandings));
res.json({success:true,count:data.length,data});
} catch (e) { res.status(500).json({success:false,error:e.message}); }
});

app.get(”/api/records”, async (req, res) => {
try {
const games = await getCached(“schedule”, TTL.schedule, fetchAllSchedules);
res.json({success:true,data:computeRecords(games)});
} catch (e) { res.status(500).json({success:false,error:e.message}); }
});

app.get(”/api/overview”, async (req, res) => {
try {
const ov = await getCached(“overview”, TTL.overview, () => fetchHTML(NEWS_URL).then(parseOverview));
if (CACHE.schedule.data) ov.records = computeRecords(CACHE.schedule.data);
res.json({success:true,data:ov});
} catch (e) { res.status(500).json({success:false,error:e.message}); }
});

// Lets the frontend always know which sports are in postseason
app.get(”/api/postseason”, (_, res) => res.json({success:true,data:POSTSEASON_SPORTS,seasonOver:SEASON_OVER}));

// Admin: force refresh
app.post(”/api/cache/bust”, async (_, res) => {
Object.keys(CACHE).forEach(k=>{CACHE[k].ts=0;});
try { await fetchAllSchedules().then(d=>{CACHE.schedule={data:d,ts:Date.now()};}); } catch {}
res.json({success:true,message:“Cache cleared and refreshed.”});
});

/* ── Startup ─────────────────────────────────────────────────────────────── */
async function warmCache() {
console.log(”\n🦅 Warming cache from MaxPreps…”);
await Promise.allSettled([
getCached(“schedule”,  TTL.schedule,  fetchAllSchedules),
getCached(“standings”, TTL.standings, () => fetchHTML(STANDINGS_URL).then(parseStandings)),
getCached(“overview”,  TTL.overview,  () => fetchHTML(NEWS_URL).then(parseOverview)),
]);
console.log(“Cache ready ✓\n”);
}

setInterval(() => {
fetchAllSchedules()
.then(d=>{CACHE.schedule={data:d,ts:Date.now()}; console.log(”[auto-refresh] ✓”);})
.catch(e=>console.warn(”[auto-refresh] ✗”,e.message));
}, 5*60*1000);

app.listen(PORT, () => {
console.log(`\n🦅 BCHS Eagles Backend v2.0  →  http://localhost:${PORT}`);
setTimeout(warmCache, 1500);
});

module.exports = app;
