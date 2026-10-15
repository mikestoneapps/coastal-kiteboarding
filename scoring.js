// scoring.js — Gorge or Coast scoring model, extracted from the prototype (Oct 2026).
// Pure functions, no DOM. See SPEC.md §3.
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
  const gfs=f.m&&f.m.gfs&&nz(wi.map(i=>f.m.gfs.spd[i])), icon=f.m&&f.m.icon&&nz(wi.map(i=>f.m.icon.spd[i]));
  let agree=null;
  if(gfs&&gfs.length&&icon&&icon.length){ const d=Math.max(Math.abs(avg(gfs)-spd),Math.abs(avg(icon)-spd),Math.abs(avg(gfs)-avg(icon))); agree= d<=4?"Models agree": d<=8?"Models mixed":"Models disagree"; }
  const wh=f.wh? avg(nz(wi.map(i=>m2ft(f.wh[i])))):null, wp=f.wp? avg(nz(wi.map(i=>f.wp[i]))):null;
  const temp=avg(nz(wi.map(i=>f.temp[i])));
  const gates=win.map(w=>w.gate).filter(Boolean), whys=win.map(w=>w.why).filter(Boolean);
  const reason= gates[0] || mode(whys);
  const dh=win.find(w=>(w.gate||w.why)===reason)||win[0];
  return {score:Math.round(best.v*10)/10, from:+f.time[wi[0]].slice(11,13), to:+f.time[wi[wi.length-1]].slice(11,13)+1, spd,gst,dir,agree,wh,wp,temp,reason,mine:dh&&dh.mine,hours:hs,idx,window:N};
}
function mode(a){ if(!a.length) return null; const c={}; a.forEach(x=>c[x]=(c[x]||0)+1); return Object.keys(c).sort((x,y)=>c[y]-c[x])[0]; }

const COMPASS=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
function compass(d){ return d==null?"–":COMPASS[Math.round(d/22.5)%16]; }
function hhmm(h){ const x=((h+11)%12)+1; return x+(h<12?"a":"p"); }
function mins(m){ return m<60? m+" min" : Math.floor(m/60)+"h"+String(m%60).padStart(2,"0"); }
function cls(s,gate){ return gate?"gate": s>=7?"good": s>=4?"ok":"poor"; }
function kiteFor(spd){ const kg=settings.weightLb*KG; const ideal=kg*2.175/Math.max(spd,6); const ks=settings.kites.length?settings.kites:[7,9,12,14]; return ks.reduce((a,k)=>Math.abs(k-ideal)<Math.abs(a-ideal)?k:a, ks[0]); }

if(typeof module!=="undefined") module.exports={STYLES,DEFAULT_WEIGHTS,DEFAULT_COMFORT,limitsFor,settings,hourScore,dayScore,speedScore,dirScore,gustScore,waveScore,wxScore,compass,hhmm,kiteFor};
