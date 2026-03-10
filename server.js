const express=require(“express”),cors=require(“cors”),https=require(“https”),http=require(“http”),cheerio=require(“cheerio”);
const app=express(),PORT=process.env.PORT||3001;
app.use(cors());
app.use(express.json());
const MP=“https://www.maxpreps.com/ca/bakersfield/bakersfield-christian-eagles”;
const URLS={
football:MP+”/football/schedule/”,
basketball:MP+”/basketball/schedule/”,
basketball_g:MP+”/girls-basketball/schedule/”,
baseball:MP+”/baseball/schedule/”,
softball:MP+”/softball/schedule/”,
soccer:MP+”/boys-soccer/schedule/”,
soccer_g:MP+”/girls-soccer/schedule/”,
volleyball:MP+”/girls-volleyball/schedule/”,
volleyball_boys:MP+”/boys-volleyball/schedule/”,
};
const CACHE={schedule:{data:null,ts:0},standings:{data:null,ts:0}};
const TTL_S=5*60*1000,TTL_ST=15*60*1000;
function fetchHTML(url,hops){
hops=hops||0;
return new Promise(function(resolve,reject){
if(hops>4)return reject(new Error(“too many redirects”));
var client=url.startsWith(“https”)?https:http;
var req=client.get(url,{
headers:{
“User-Agent”:“Mozilla/5.0 Chrome/122.0.0.0 Safari/537.36”,
“Accept”:“text/html,*/*”,
“Referer”:“https://www.maxpreps.com/”
},
timeout:12000
},function(res){
if([301,302,303,307,308].indexOf(res.statusCode)>-1&&res.headers.location){
return fetchHTML(res.headers.location,hops+1).then(resolve).catch(reject);
}
if(res.statusCode!==200)return reject(new Error(“HTTP “+res.statusCode));
var b=””;
res.setEncoding(“utf8”);
res.on(“data”,function(c){b+=c;});
res.on(“end”,function(){resolve(b);});
});
req.on(“error”,reject);
req.on(“timeout”,function(){req.destroy();reject(new Error(“timeout”));});
});
}
function abbr(n){
var clean=n.replace(/\s+(High School|HS|Academy|Christian|Catholic|Prep)$/i,””).trim();
var words=clean.split(/\s+/);
var r=words.length===1?clean.substring(0,4):words.map(function(w){return w[0];}).join(””);
return r.toUpperCase().substring(0,4)||n.substring(0,3).toUpperCase();
}
function fmtDate(d){
if(!d)return”TBD”;
try{
var dt=new Date(d);
if(isNaN(dt.getTime()))return String(d);
return dt.toLocaleDateString(“en-US”,{weekday:“short”,month:“short”,day:“numeric”});
}catch(e){return String(d);}
}
function parseGame(g,sport,icon){
if(!g)return null;
try{
var opp=(g.opponent&&g.opponent.name)||g.opponentName||(g.away&&g.away.name)||String(g.opponent||“Unknown”);
var isHome=!g.isAway&&(g.isHome||g.homeAway===“home”);
var ds=g.date||g.scheduledDate||g.gameDate||g.startDate;
var bs=g.homeScore!=null?g.homeScore:g.ourScore!=null?g.ourScore:g.teamScore!=null?g.teamScore:null;
var os=g.awayScore!=null?g.awayScore:g.oppScore!=null?g.oppScore:g.opponentScore!=null?g.opponentScore:null;
var has=bs!=null&&os!=null;
var letter=has?(bs===os?“T”:bs>os?“W”:“L”):null;
return{sport:sport,icon:icon,opponent:opp,oppAbbr:abbr(opp),date:fmtDate(ds),time:g.time||g.startTime||null,isHome:isHome,level:g.level||“V”,result:has?letter+” “+bs+”-”+os:null,bcScore:has?bs:null,oppScore:has?os:null};
}catch(e){return null;}
}
function parseSchedule(html,sport,icon){
var $=cheerio.load(html);
var games=[];
var nd=$(“script#**NEXT_DATA**”).html();
if(nd){
try{
var props=JSON.parse(nd).props.pageProps;
var raw=props.schedule||props.contests||props.games||(props.team&&props.team.schedule);
if(Array.isArray(raw)&&raw.length){
raw.forEach(function(g){var p=parseGame(g,sport,icon);if(p)games.push(p);});
console.log(“ok “+sport+”: “+games.length);
return games;
}
}catch(e){console.warn(“json fail “+sport+”: “+e.message);}
}
$(“table tr”).each(function(*,row){
var c=$(row).find(“td”);
if(c.length<3)return;
var opp=$(c[1]).text().trim();
var sc=$(c[2]).text().trim();
if(!opp)return;
var sm=sc.match(/([WLT])\s*(\d+)[-](\d+)/i);
var tm=sc.match(/(\d+:\d+\s*[AP]M)/i);
games.push({sport:sport,icon:icon,opponent:opp,oppAbbr:abbr(opp),date:$(c[0]).text().trim(),time:tm?tm[1]:null,isHome:!/^@/.test(opp),level:“V”,result:sm?sm[1].toUpperCase()+” “+sm[2]+”-”+sm[3]:null,bcScore:sm?parseInt(sm[2]):null,oppScore:sm?parseInt(sm[3]):null});
});
console.log(“html “+sport+”: “+games.length);
return games;
}
function parseStandings(html){
var $=cheerio.load(html);
var teams=[];
var nd=$(“script#**NEXT_DATA**”).html();
if(nd){
try{
var props=JSON.parse(nd).props.pageProps;
var raw=props.standings||props.leagueStandings||(props.division&&props.division.teams);
if(Array.isArray(raw)&&raw.length){
raw.forEach(function(t,i){teams.push({rank:i+1,team:t.name||t.teamName||”?”,w:t.wins||t.w||0,l:t.losses||t.l||0,us:(t.name||””).toLowerCase().indexOf(“bakersfield christian”)>-1});});
return teams;
}
}catch(e){}
}
$(“table tr”).each(function(*,r){
var c=$(r).find(“td”);
if(c.length<3)return;
var name=$(c[0]).text().trim();
if(name&&!/^(team|school)/i.test(name))teams.push({rank:teams.length+1,team:name,w:parseInt($(c[1]).text())||0,l:parseInt($(c[2]).text())||0,us:name.toLowerCase().indexOf(“bakersfield christian”)>-1});
});
return teams;
}
function fetchAll(){
var sports=[
{key:“football”,name:“Football”,icon:“🏈”},
{key:“basketball”,name:“Boys Basketball”,icon:“🏀”},
{key:“basketball_g”,name:“Girls Basketball”,icon:“🏀”},
{key:“baseball”,name:“Baseball”,icon:“⚾”},
{key:“softball”,name:“Softball”,icon:“🥎”},
{key:“soccer”,name:“Boys Soccer”,icon:“⚽”},
{key:“soccer_g”,name:“Girls Soccer”,icon:“⚽”},
{key:“volleyball”,name:“Girls Volleyball”,icon:“🏐”},
{key:“volleyball_boys”,name:“Boys Volleyball”,icon:“🏐”}
];
var all=[];
return Promise.allSettled(sports.map(function(s){
if(!URLS[s.key])return Promise.resolve();
return fetchHTML(URLS[s.key]).then(function(html){
var games=parseSchedule(html,s.name,s.icon);
all=all.concat(games);
}).catch(function(e){console.warn(“fail “+s.name+”: “+e.message);});
})).then(function(){
var now=new Date();
return all.sort(function(a,b){
var da=new Date(a.date),db=new Date(b.date);
var af=da>=now,bf=db>=now;
if(af&&!bf)return -1;
if(!af&&bf)return 1;
return af?da-db:db-da;
});
});
}
function computeRecords(games){
var r={};
games.forEach(function(g){
if(!g.result)return;
if(!r[g.sport])r[g.sport]={w:0,l:0,t:0};
var l=g.result[0];
if(l===“W”)r[g.sport].w++;
else if(l===“L”)r[g.sport].l++;
else if(l===“T”)r[g.sport].t++;
});
return r;
}
function getCached(key,ttl,fn){
var now=Date.now();
if(CACHE[key].data&&(now-CACHE[key].ts)<ttl)return Promise.resolve(CACHE[key].data);
return fn().then(function(d){
CACHE[key]={data:d,ts:Date.now()};
return d;
}).catch(function(e){
console.error(“cache “+key+”: “+e.message);
if(CACHE[key].data)return CACHE[key].data;
throw e;
});
}
app.get(”/api/health”,function(*,res){
res.json({status:“ok”,version:“2.0.0”,school:“BCHS Eagles”,cache:{schedule:CACHE.schedule.ts?new Date(CACHE.schedule.ts).toISOString():null}});
});
app.get(”/api/schedule”,function(req,res){
getCached(“schedule”,TTL_S,fetchAll).then(function(games){
var sport=req.query.sport,type=req.query.type||“all”;
if(sport)games=games.filter(function(g){return g.sport.toLowerCase().indexOf(sport.toLowerCase())>-1;});
if(type===“upcoming”)games=games.filter(function(g){return!g.result;});
if(type===“results”)games=games.filter(function(g){return!!g.result;});
res.json({success:true,count:games.length,data:games});
}).catch(function(e){res.status(500).json({success:false,error:e.message});});
});
app.get(”/api/standings”,function(*,res){
getCached(“standings”,TTL_ST,function(){return fetchHTML(MP+”/basketball/standings/”).then(parseStandings);}).then(function(d){
res.json({success:true,count:d.length,data:d});
}).catch(function(e){res.status(500).json({success:false,error:e.message});});
});
app.get(”/api/records”,function(*,res){
getCached(“schedule”,TTL_S,fetchAll).then(function(g){
res.json({success:true,data:computeRecords(g)});
}).catch(function(e){res.status(500).json({success:false,error:e.message});});
});
app.get(”/api/overview”,function(*,res){
getCached(“schedule”,TTL_S,fetchAll).then(function(g){
res.json({success:true,data:{records:computeRecords(g)}});
}).catch(function(e){res.status(500).json({success:false,error:e.message});});
});
app.get(”/api/postseason”,function(*,res){
res.json({success:true,data:{“Boys Basketball”:{label:“CIF State SoCal Regionals”,sublabel:“Div II - #3 Seed”,round:“Quarterfinals”,urgent:true}}});
});
app.post(”/api/cache/bust”,function(*,res){
Object.keys(CACHE).forEach(function(k){CACHE[k].ts=0;});
res.json({success:true,message:“Cache cleared.”});
});
app.listen(PORT,function(){
console.log(“BCHS Eagles Backend running on port “+PORT);
setTimeout(function(){
fetchAll().then(function(d){
CACHE.schedule={data:d,ts:Date.now()};
console.log(“Cache ready”);
}).catch(function(e){console.warn(“Cache warm failed: “+e.message);});
},1500);
});
module.exports=app;
