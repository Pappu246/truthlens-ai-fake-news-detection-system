#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
function arg(name,fallback){const v=process.argv.find(x=>x.startsWith('--'+name+'='));return v?v.slice(name.length+3):fallback;}
function find(root,name){const out=[];for(const e of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,e.name);if(e.isDirectory())out.push(...find(p,name));else if(e.isFile()&&e.name===name)out.push(p);}return out;}

const AVERITEC_LABELS = ['Supported', 'Refuted', 'Not Enough Evidence', 'Conflicting Evidence/Cherrypicking'];
function macroF1(gold, predicted, labels) {
  if (gold.length !== predicted.length) throw new Error('Metric denominator mismatch');
  const perClass = labels.map(label => {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < gold.length; i++) {
      if (gold[i] === label && predicted[i] === label) tp++;
      else if (gold[i] !== label && predicted[i] === label) fp++;
      else if (gold[i] === label && predicted[i] !== label) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { label, precision, recall, f1, support: tp + fn };
  });
  const accuracy = gold.length ? gold.reduce((n, label, i) => n + Number(label === predicted[i]), 0) / gold.length : 0;
  return { accuracy, macro_f1: perClass.reduce((sum, item) => sum + item.f1, 0) / labels.length, per_class: perClass };
}
const inputDir=path.resolve(arg('input-dir','artifacts/v2-averitec-shards'));
const outputDir=path.resolve(arg('output-dir','artifacts/v2-averitec-e2e'));
fs.mkdirSync(outputDir,{recursive:true});
const provFiles=find(inputDir,'provenance.json');
if(provFiles.length!==4) throw new Error('Expected 4 shard provenance files, got '+provFiles.length);
const shards=provFiles.map(p=>{
  const dir=path.dirname(p), predictions=JSON.parse(fs.readFileSync(path.join(dir,'predictions.json'),'utf8')), provenance=JSON.parse(fs.readFileSync(p,'utf8'));
  const start=Number(provenance.claim_range?.start_claim), count=Number(provenance.claim_range?.claim_count);
  if(!Number.isInteger(start)||!Number.isInteger(count)||predictions.length!==count||provenance.evaluation_count!==count) throw new Error('Invalid shard '+p);
  return {start,count,predictions,provenance,dir};
}).sort((a,b)=>a.start-b.start);
let next=0;
for(const s of shards){if(s.start!==next) throw new Error('Non-contiguous coverage: expected '+next+' got '+s.start);next+=s.count;}
if(next!==500) throw new Error('Expected 500 claims, got '+next);
const predictions=shards.flatMap(s=>s.predictions), claims=shards.flatMap(s=>s.provenance.claims);
if(predictions.length!==500||claims.length!==500) throw new Error('Combined count is not 500');
for(let i=0;i<500;i++) if(claims[i]?.id!==i) throw new Error('Claim order mismatch at '+i);
const goldLabels=claims.map(c=>c.gold_label);
const benchmarkLabels=claims.map(c=>c.prediction_label);
const productionLabels=claims.map(c=>c.production_prediction_label);
for(let i=0;i<500;i++){
  if(!AVERITEC_LABELS.includes(goldLabels[i])||!AVERITEC_LABELS.includes(benchmarkLabels[i])||!AVERITEC_LABELS.includes(productionLabels[i])) throw new Error('Invalid metric label at claim '+i);
  if(predictions[i]?.label!==benchmarkLabels[i]) throw new Error('Prediction/provenance label mismatch at claim '+i);
}
const benchmarkMetrics=macroF1(goldLabels,benchmarkLabels,AVERITEC_LABELS);
const productionMetrics=macroF1(goldLabels,productionLabels,AVERITEC_LABELS);
productionMetrics.abstention_or_conflict_rate=productionLabels.filter(label=>label==='Not Enough Evidence'||label==='Conflicting Evidence/Cherrypicking').length/productionLabels.length;
const provenance={...shards[0].provenance,evaluation_scope:'full_500_claim_dev',evaluation_count:500,claim_range:{start_claim:0,claim_count:500,end_exclusive:500},shard_count:4,shard_size:125,claims,research_metrics:{benchmark_directional:benchmarkMetrics,production_policy_mapped:productionMetrics},shards:shards.map(s=>({start_claim:s.start,claim_count:s.count,evaluation_scope:s.provenance.evaluation_scope,bundle_sha256:fs.readFileSync(path.join(s.dir,'bundle-sha256.txt'),'utf8').trim()}))};
if(provenance.runner) delete provenance.runner.start_claim;
fs.writeFileSync(path.join(outputDir,'predictions.json'),JSON.stringify(predictions,null,2)+'\n');
fs.writeFileSync(path.join(outputDir,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
const digest=crypto.createHash('sha256').update(fs.readFileSync(path.join(outputDir,'predictions.json'))).update(fs.readFileSync(path.join(outputDir,'provenance.json'))).digest('hex');
fs.writeFileSync(path.join(outputDir,'bundle-sha256.txt'),digest+'\n');
console.log(JSON.stringify({ok:true,evaluated_claims:500,shard_count:4,bundle_sha256:digest},null,2));
