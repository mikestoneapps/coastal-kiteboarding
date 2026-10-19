// scoring.js — Gorge or Coast scoring model, extracted from the prototype (Oct 2026).
// Pure functions, no DOM. See SPEC.md §3.
// Docs from fetchForecasts() go through consensus() first: spd/gst are the per-hour median of best match, ECMWF and NBM.
// Usage: const r = dayScore(spot, forecastDoc, "2026-10-17", "freeride", {speed:1,dir:1,gust:1,wave:1,wx:1}, limits);
//   limits = the rider's comfort profile merged with the spot override: limitsFor(settings, spot.id).
//   Omit it for the default comfort profile. Identical to the scoring in index.html; alerts/test.mjs checks that.
const DEFAULT_WEIGHTS = {speed:1, dir:1, gust:1, wave:1, wx:1};
const DEFAULT_COMFORT = {minWind:12, maxWind:32, maxGust:34, maxSurf:9, minHours:3, stretch:true};
let settings = { weights: {...DEFAULT_WEIGHTS}, weightLb:185, kites:[7,9,12,14], comfort:{...DEFAULT_COMFORT}, overrides:{} };
function limitsFor(s, spotId){ return {...DEFAULT_COMFORT, ...((s&&s.comfort)||{}), ...(((s&&s.overrides)||{})[spotId]||{})}; }
const STYLES = {freeride:{lo:14,peak:20,hi:27,label:"Freeride"}, wave:{lo:14,peak:19,hi:24,label:"Wave"}, foil:{lo:9,peak:13,hi:18,label:"Foil"}};
const DAY_START=7, DAY_END=19, NUKE=35;
const KG=0.4536;
/* ---------- scoring ---------- */
/* models: Open-Meteo returns several per hour. The score runs on the per-hour median of best match, ECMWF and NBM;
   GFS and ICON only vote on confidence. Single models disagree by 5–10 kn at the Gorge and coast spots (SPEC §3). */
const MODELS=[["bm","Best match"],["ecmwf","ECMWF"],["nbm","NBM"],["gfs","GFS"],["icon","ICON"]];
function median(xs){ const a=xs.filter(x=>x!=null).sort((x,y)=>x-y); if(!a.length) return null; const m=a.length>>1; return a.length%2? a[m] : (a[m-1]+a[m])/2; }
function consensus(f){
  // f.spd / f.gst := per-hour median of f.m.bm, f.m.ecmwf, f.m.nbm (whichever have a value that hour); direction stays best match's.
  // With fewer than two of those in the doc (an older cache, a point outside their domains) the doc comes back unchanged.
  const M=f.m||{}; const src=["bm","ecmwf","nbm"].map(k=>M[k]).filter(x=>x&&x.spd);
  if(src.length<2) return f;
  const med=(key,i)=>{ const v=median(src.map(x=>x[key]&&x[key][i])); return v==null? f[key][i] : Math.round(v*10)/10; };
  return {...f, spd:f.spd.map((_,i)=>med("spd",i)), gst:f.gst.map((_,i)=>med("gst",i))};
}
function modelSpread(f, wi, spd){
  // Best-window mean per model, over every model the doc carries (up to five). Older docs have no f.m.bm: their spd is best match itself.
  const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
  const mm=[]; for(const [k,label] of MODELS){ const a=f.m&&f.m[k]&&f.m[k].spd? wi.map(i=>f.m[k].spd[i]).filter(x=>x!=null):[]; if(a.length) mm.push({k,label,v:avg(a)}); }
  if(!mm.some(x=>x.k==="bm") && mm.length && spd!=null) mm.unshift({k:"bm",label:"Best match",v:spd});
  if(mm.length<2) return null;
  const lo=mm.reduce((a,b)=>b.v<a.v?b:a), hi=mm.reduce((a,b)=>b.v>a.v?b:a), d=hi.v-lo.v;
  return {lo:lo.v, hi:hi.v, loLabel:lo.label, hiLabel:hi.label, n:mm.length, agree: d<=4?"Models agree": d<=8?"Models mixed":"Models disagree"};
}
function inSectors(d, secs){ return secs.some(([a,b])=> a<=b ? (d>=a && d<=b) : (d>=a || d<=b)); }
function dirScore(d, dir){
  if(d==null) return {v:0.5};
  if(inSectors(d,dir.off)) return {v:0,gate:"Offshore"};
  if(inSectors(d,dir.best)) return {v:1};
  if(inSectors(d,dir.work)) return {v:0.75};
  return {v:0.4,why:"Cross-off"};
}
function speedScore(s, st){
  if(s==null) return {v:0};
  if(s>=NUKE) return {v:0,gate:"Nuking"};
  const {lo,peak,hi}=st;
  if(s<lo-4) return {v:0,why:"Too light"};
  if(s<lo) return {v:0.6*(s-(lo-4))/4,why:"Light"};
  if(s<=peak) return {v:0.6+0.4*(s-lo)/(peak-lo)};
  if(s<=hi) return {v:1-0.3*(s-peak)/(hi-peak)};
  if(s<hi+6) return {v:0.7*(1-(s-hi)/6),why:"Strong"};
  return {v:0,why:"Too strong"};
}
function gustScore(s,g){
  if(s==null||g==null||s<5) return {v:1};
  if(g>=38) return {v:0,gate:"Nuking"};
  const r=g/s; if(r<=1.3) return {v:1};
  const v=Math.max(0.3, 1-(r-1.3)/0.6*0.7); return {v, why: r>1.5?"Gusty":undefined};
}
function waveScore(ft, st){
  if(ft==null) return {v:1};
  if(st==="wave"){ if(ft<1.5) return {v:0.7,why:"Flat"}; if(ft<=7) return {v:1}; if(ft<=9) return {v:0.8}; return {v:0.5,why:"Big surf"}; }
  if(st==="foil"){ if(ft<=3) return {v:1}; if(ft<=5) return {v:0.75}; return {v:0.5,why:"Big surf"}; }
  if(ft<=5) return {v:1}; if(ft<=8) return {v:0.8}; return {v:0.5,why:"Big surf"};
}
function wxScore(code,vis,pop){
  if(code!=null && code>=95) return {v:0,gate:"Storms"};
  let v=1, why;
  if(code===45||code===48||(vis!=null&&vis<1600)){ v*=0.5; why="Fog"; }
  if(pop!=null&&pop>60){ v*=0.85; why=why||"Rain"; }
  return {v,why};
}
function hourScore(spot, f, i, style, limits){
  const st=STYLES[style];
  const w=settings.weights, L=limits||limitsFor(settings, spot.id);
  const spd=f.spd[i], gst=f.gst[i], dr=f.dir[i], ft=spot.waves&&f.wh? m2ft(f.wh[i]):null;
  const sp=speedScore(spd,st), di=dirScore(dr,spot.dir), gu=gustScore(spd,gst), wv=spot.waves? waveScore(ft,style):{v:1}, wx=wxScore(f.code[i],f.vis[i],f.pop[i]);
  // personal limits (the rider's, from the comfort profile or a per-spot override)
  const mine=[];
  if(spd!=null && Math.round(spd)>L.maxWind) mine.push({v:0,gate:"Over your max",mine:true});
  if(gst!=null && Math.round(gst)>L.maxGust) mine.push({v:0,gate:"Gusts over your limit",mine:true});
  if(spd!=null && spd<L.minWind && spd>=st.lo-4) mine.push({v:0.5,why:"Below your min",mine:true});
  if(ft!=null && ft>L.maxSurf) mine.push({v:0.35,why:"Surf over your limit",mine:true});
  const parts=[[sp,w.speed],[di,w.dir],[gu,w.gust],[wv,w.wave],[wx,w.wx],...mine.map(m=>[m,1])];
  const gate=parts.find(([p])=>p.gate);
  // weighted geometric: each factor's influence is raised to its weight (0 = ignored, 2 = counts double)
  let v=parts.reduce((a,[p,wt])=>a*Math.pow(Math.max(p.v,0.001),wt),1);
  let worst=parts.reduce((a,[p,wt])=> (wt>0 && Math.pow(p.v,wt)<a.pv)? {p,pv:Math.pow(p.v,wt)}:a, {p:{v:2},pv:2}).p;
  const g=gate&&gate[0];
  return {v:gate?0:v*10, gate:g&&g.gate, why: worst.why||worst.gate, mine: g? !!g.mine: !!worst.mine};
}
function m2ft(m){ return m==null?null:m*3.281; }
function dayScore(spot, f, day, style, weights, limits){
  if(weights) settings.weights=weights;
  const L=limits||limitsFor(settings, spot.id);
  const idx=[]; f.time.forEach((t,i)=>{ if(t.startsWith(day)){ const h=+t.slice(11,13); if(h>=DAY_START&&h<=DAY_END) idx.push(i);} });
  if(!idx.length) return null;
  const hs=idx.map(i=>({i,...hourScore(spot,f,i,style,L)}));
  const N=Math.min(Math.max(Math.round(L.minHours||3),1),6);
  let best={v:-1,start:0};
  for(let k=0;k+N-1<hs.length;k++){ let m=0; for(let j=0;j<N;j++) m+=hs[k+j].v; m/=N; if(m>best.v) best={v:m,start:k}; }
  const win=hs.slice(best.start,best.start+N);
  const wi=win.map(w=>w.i);
  const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
  const nz=a=>a.filter(x=>x!=null);
  const spd=avg(nz(wi.map(i=>f.spd[i]))), gst=avg(nz(wi.map(i=>f.gst[i]))), dir=f.dir[wi[Math.floor(wi.length/2)]];
  const models=modelSpread(f, wi, spd), agree=models? models.agree:null;   // all five models vote; the score itself ran on the median (consensus())
  const wh=f.wh? avg(nz(wi.map(i=>m2ft(f.wh[i])))):null, wp=f.wp? avg(nz(wi.map(i=>f.wp[i]))):null;
  const temp=avg(nz(wi.map(i=>f.temp[i])));
  const gates=win.map(w=>w.gate).filter(Boolean), whys=win.map(w=>w.why).filter(Boolean);
  const reason= gates[0] || mode(whys);
  const dh=win.find(w=>(w.gate||w.why)===reason)||win[0];
  return {score:Math.round(best.v*10)/10, from:+f.time[wi[0]].slice(11,13), to:+f.time[wi[wi.length-1]].slice(11,13)+1, spd,gst,dir,agree,models,wh,wp,temp,reason,mine:dh&&dh.mine,hours:hs,idx,window:N};
}
function mode(a){ if(!a.length) return null; const c={}; a.forEach(x=>c[x]=(c[x]||0)+1); return Object.keys(c).sort((x,y)=>c[y]-c[x])[0]; }

const COMPASS=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
function compass(d){ return d==null?"–":COMPASS[Math.round(d/22.5)%16]; }
function hhmm(h){ const x=((h+11)%12)+1; return x+(h<12?"a":"p"); }
function mins(m){ return m<60? m+" min" : Math.floor(m/60)+"h"+String(m%60).padStart(2,"0"); }
function cls(s,gate){ return gate?"gate": s>=7?"good": s>=4?"ok":"poor"; }
function kiteFor(spd){ const kg=settings.weightLb*KG; const ideal=kg*2.175/Math.max(spd,6); const ks=settings.kites.length?settings.kites:[7,9,12,14]; return ks.reduce((a,k)=>Math.abs(k-ideal)<Math.abs(a-ideal)?k:a, ks[0]); }

if(typeof module!=="undefined") module.exports={STYLES,DEFAULT_WEIGHTS,DEFAULT_COMFORT,MODELS,limitsFor,settings,median,consensus,modelSpread,hourScore,dayScore,speedScore,dirScore,gustScore,waveScore,wxScore,compass,hhmm,kiteFor};
