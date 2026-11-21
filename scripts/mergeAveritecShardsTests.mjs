#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mergeAveritecShards.mjs');
const LABELS = ['Supported', 'Refuted', 'Not Enough Evidence', 'Conflicting Evidence/Cherrypicking'];
const BENCHMARK_LABELS = ['Supported', 'Refuted', 'Not Enough Evidence'];

function metrics(gold, predicted) {
  const perClass = LABELS.map(label => {
    let tp=0, fp=0, fn=0;
    for (let i=0;i<gold.length;i++) {
      if (gold[i]===label && predicted[i]===label) tp++;
      else if (gold[i]!==label && predicted[i]===label) fp++;
      else if (gold[i]===label && predicted[i]!==label) fn++;
    }
    const precision=tp+fp?tp/(tp+fp):0, recall=tp+fn?tp/(tp+fn):0;
    const f1=precision+recall?2*precision*recall/(precision+recall):0;
    return {label,precision,recall,f1,support:tp+fn};
  });
  return {
    accuracy: gold.reduce((n,label,i)=>n+Number(label===predicted[i]),0)/gold.length,
    macro_f1: perClass.reduce((n,row)=>n+row.f1,0)/LABELS.length,
    per_class: perClass
  };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'truthlens-averitec-aggregate-test-'));
try {
  const input = path.join(temp, 'shards');
  const output = path.join(temp, 'out');
  fs.mkdirSync(input);
  for (let start=0;start<500;start+=125) {
    const dir=path.join(input, 'shard-'+start);
    fs.mkdirSync(dir);
    const claims=[], predictions=[];
    for (let id=start;id<start+125;id++) {
      const gold=LABELS[id%LABELS.length];
      const benchmark = id<125
        ? (BENCHMARK_LABELS.includes(gold)?gold:'Not Enough Evidence')
        : BENCHMARK_LABELS[(id*2+1)%BENCHMARK_LABELS.length];
      const production = id<125 ? gold : LABELS[(id+1)%LABELS.length];
      claims.push({id,gold_label:gold,prediction_label:benchmark,production_prediction_label:production});
      predictions.push({label:benchmark,string_evidence:[],justification:''});
    }
    const provenance={
      evaluation_count:125,
      claim_range:{start_claim:start,claim_count:125,end_exclusive:start+125},
      evaluation_scope:'shard_'+start+'_'+(start+125)+'_of_500',
      claims,
      research_metrics:{benchmark_directional:{accuracy:1,macro_f1:1},production_policy_mapped:{accuracy:1,macro_f1:1}},
      runner:{start_claim:start}
    };
    fs.writeFileSync(path.join(dir,'predictions.json'),JSON.stringify(predictions)+'\n');
    fs.writeFileSync(path.join(dir,'provenance.json'),JSON.stringify(provenance)+'\n');
    fs.writeFileSync(path.join(dir,'bundle-sha256.txt'),('a'.repeat(64))+'\n');
  }
  const result=spawnSync(process.execPath,[SCRIPT,'--input-dir='+input,'--output-dir='+output],{encoding:'utf8'});
  if(result.status!==0) throw new Error(result.stderr||result.stdout||'aggregator exited nonzero');
  const provenance=JSON.parse(fs.readFileSync(path.join(output,'provenance.json'),'utf8'));
  const predictions=JSON.parse(fs.readFileSync(path.join(output,'predictions.json'),'utf8'));
  if(predictions.length!==500||provenance.claims.length!==500||provenance.evaluation_count!==500) throw new Error('full-split denominator is not 500');
  if(provenance.runner?.start_claim!==undefined) throw new Error('shard-specific runner metadata leaked into full-split provenance');
  const gold=provenance.claims.map(c=>c.gold_label);
  const benchmark=provenance.claims.map(c=>c.prediction_label);
  const production=provenance.claims.map(c=>c.production_prediction_label);
  const expectedBenchmark=metrics(gold,benchmark);
  const expectedProduction=metrics(gold,production);
  expectedProduction.abstention_or_conflict_rate=production.filter(x=>x==='Not Enough Evidence'||x==='Conflicting Evidence/Cherrypicking').length/500;
  const actual=provenance.research_metrics;
  if(actual.benchmark_directional.accuracy!==expectedBenchmark.accuracy||Math.abs(actual.benchmark_directional.macro_f1-expectedBenchmark.macro_f1)>1e-12) throw new Error('benchmark metrics were not recomputed over all 500 claims');
  if(actual.production_policy_mapped.accuracy!==expectedProduction.accuracy||Math.abs(actual.production_policy_mapped.macro_f1-expectedProduction.macro_f1)>1e-12||actual.production_policy_mapped.abstention_or_conflict_rate!==expectedProduction.abstention_or_conflict_rate) throw new Error('production-policy metrics were not recomputed over all 500 claims');
  if(actual.benchmark_directional.accuracy===1) throw new Error('stale first-shard metric survived aggregation');
  console.log('AVeriTeC shard aggregation regression: PASS (full 500-claim metric recomputation)');
} finally {
  fs.rmSync(temp,{recursive:true,force:true});
}
