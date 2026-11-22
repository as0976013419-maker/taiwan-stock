process.env.DEMO="1";const NEW=process.argv[2],OLD=process.argv[3];
const N={demo:require(NEW+"/src/demo"),an:require(NEW+"/src/analyze"),scan:require(NEW+"/src/scan")},O={demo:require(OLD+"/src/demo"),an:require(OLD+"/src/analyze"),scan:require(OLD+"/src/scan")};
const J=JSON.stringify;let checks=0,diffs=0;const D=(l,a,b)=>{checks++;if(J(a)!==J(b)){diffs++;if(diffs<8)console.log("  ≠",l,J(a).slice(0,120),"→",J(b).slice(0,120))}};const changed=new Map();const C=(k)=>changed.set(k,(changed.get(k)||0)+1);
(async()=>{for(const c of (await N.demo.getMarketSnapshot()).stocks.keys()){const a=await O.an.analyze(O.demo,c),b=await N.an.analyze(N.demo,c);
 D(c+" score",a.scored.score,b.scored.score);D(c+" detail",a.scored.detail,b.scored.detail);D(c+" grade",a.scored.grade,b.scored.grade);
 const oi={};for(const k of Object.keys(a.indicators))oi[k]=b.indicators[k];D(c+" indicators(舊欄位)",a.indicators,oi);
 for(const k of ["risk","trend","turtle","factors"])D(c+" quant."+k,a.quant[k],b.quant[k]);
 D(c+" rs 數值",a.quant.rs.map(r=>[r.k,r.ret,r.tr,r.idx,r.excess]),b.quant.rs.map(r=>[r.k,r.ret,r.tr,r.idx,r.excess]));
 D(c+" events",a.quant.events.events.map(e=>[e.key,e.count,e.h]),b.quant.events.events.map(e=>[e.key,e.count,e.h]));
 for(const k of ["price","prevClose","change","changePct","volume","date"])D(c+" quote."+k,a.quote[k],b.quote[k]);
 for(const k of ["chip","margin","fundamentals","sector","history","missing","coverage"]){if(J(a[k])!==J(b[k]))C(k)}
 if(a.stance!==b.stance)C("stance("+a.stance+"→"+b.stance+")")}
 console.log("個股：比對",checks,"項，差異",diffs,"項");checks=0;diffs=0;
 for(const mode of ["volume","change","drop","momentum","limitup","disposition","sector"])for(const universe of ["custom","large","all"]){const a=await O.scan.runScan(O.demo,{mode,limit:30,universe}),b=await N.scan.runScan(N.demo,{mode,limit:30,universe});D(mode+"/"+universe,a.stocks,b.stocks);if(a.sectors)D(mode+" sectors",a.sectors,b.sectors)}
 console.log("掃描：比對",checks,"組，差異",diffs,"組");console.log("刻意改變的欄位（檔數）:",J([...changed]));})().catch(e=>console.log("ERR",e.stack));
