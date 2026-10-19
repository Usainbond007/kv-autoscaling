import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'demo/public/evidence');
fs.mkdirSync(out,{recursive:true});
const specs = [['kv_autoscaler','autoscale-run.log',1,'KV-aware'],['cpu_hpa','hpa-run.log',1,'CPU HPA'],['kv_repeat_2','kv-repeat-2.log',2,'KV-aware'],['hpa_repeat_2','hpa-repeat-2.log',2,'CPU HPA']];
const runs = specs.map(([id,log,trial,policy])=>{
 const text=fs.readFileSync(path.join(root,'results',log),'utf8');
 const summary=[...text.matchAll(/Aggregated\s+(\d+)\s+(\d+)\([^\n]+?\|\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/g)].at(-1);
 const percent=text.split('Response time percentiles (approximated)').at(-1).split('\n').find(l=>l.trim().startsWith('Aggregated')).trim().split(/\s+/).slice(1).map(Number);
 assert(summary && percent.length===12, `Cannot parse ${log}`);
 const rows=fs.readFileSync(path.join(root,'results',id+'_metrics.csv'),'utf8').trim().split(/\r?\n/).slice(1).map(l=>{const [t,m,i,v]=l.split(',');return {t:+t,m,i,v:Number.isFinite(+v)?+v:null};});
 const start=Math.min(...rows.map(r=>r.t));
 const metrics={};
 for(const key of ['kv_usage','running','requests_per_second','healthy_targets']){
  const groups=new Map();
  rows.filter(r=>r.m===key).forEach(r=>{if(!groups.has(r.t))groups.set(r.t,[]);groups.get(r.t).push(r);});
  metrics[key]=Array.from({length:97},(_,n)=>{const t=start+n*5;const group=groups.get(t);const valid=group?.every(r=>r.v!==null);return {t,elapsed:n*5,value:!valid?null:(key==='kv_usage'?Math.max(...group.map(r=>r.v))*100:key==='healthy_targets'?Math.max(...group.map(r=>r.v)):group.reduce((s,r)=>s+r.v,0)),instances:group?.length||0};});
 }
 for(const file of [log,id+'_metrics.csv'])fs.copyFileSync(path.join(root,'results',file),path.join(out,file));
 return {id,trial,policy,log,start,requests:+summary[1],failures:+summary[2],median:+summary[6]/1000,p95:percent[5]/1000,p99:percent[7]/1000,metrics};
});
assert.deepEqual(runs.map(r=>[r.requests,r.failures,r.median,r.p95,r.p99]),[[496,2,3,5,43],[323,4,5,6.7,90],[897,0,2.1,2.6,61],[806,0,2.2,3.3,56]]);
for(const file of ['autoscaler-decisions.log','hpa-events.txt','policy_comparison.png','policy_comparison_repeat_2.png'])fs.copyFileSync(path.join(root,'results',file),path.join(out,file));
fs.writeFileSync(path.join(root,'demo/src/data.json'),JSON.stringify(runs));
console.log('Verified four Locust summaries; bundled CSV observations on their original 5-second grid.');
