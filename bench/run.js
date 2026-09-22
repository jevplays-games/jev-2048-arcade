#!/usr/bin/env node
/** Paired-seed benchmark. JEV calls require an explicit --live flag. Journals are fsynced. */
import {mkdir, writeFile, open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {RULES_VERSION, createDuel, advanceRound, canonical} from '../public/core/rules.js';
import {RNG_VERSION, sha256, initialCells, seedCommitment, deriveSpawn} from '../public/core/crypto.js';
import {POLICY_VERSION, PROFILES, baselineAction, generateCandidates} from '../public/core/evaluate.js';
import {chooseJevAction, DEFAULT_MODEL} from '../server/jev.js';
import {createEvents, verifyBundle} from '../public/core/audit.js';
import {analyze, average, quantile, csv} from '../public/core/analytics.js';
import {BUILD_INFO} from '../server/build-info.js';
const args = process.argv.slice(2), option = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const seeds = Number(option('seeds', '5')), moveLimit = Number(option('moves', '128')), replicates = Number(option('replicates', '1'));
const policies = option('policies', 'random,greedy,heuristic').split(','), baseline = option('baseline', 'greedy');
const split = option('split', 'development'), output = resolve(option('out', 'bench/results/' + new Date().toISOString().replaceAll(':','-')));
const supported = ['random','greedy','heuristic','expectimax',...Object.keys(PROFILES).map(x=>'jev:'+x)];
if (![seeds,moveLimit,replicates].every(Number.isInteger) || seeds < 1 || seeds > 10000 || moveLimit < 1 || moveLimit > 2048 ||
    replicates < 1 || replicates > 100 || policies.some(x=>!supported.includes(x)) || !supported.slice(0,4).includes(baseline) ||
    !['development','heldout','calibration'].includes(split)) throw new Error('Invalid benchmark options. See docs/BENCHMARKS.md.');
if (policies.some(x=>x.startsWith('jev:')) && (!args.includes('--live') || !process.env.TYPESAFE_API_KEY))
  throw new Error('Live policies require --live and TYPESAFE_API_KEY. No synthetic response will be substituted.');
function randomGenerator(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
await mkdir(output,{recursive:true});
const experiment = {schemaVersion:1,createdAt:new Date().toISOString(),split,seeds,replicates,moveLimit,policies,baseline,
  liveProviderRequested:args.includes('--live'),build:BUILD_INFO,baseSeed:option('seed','2048-benchmark-v1')};
await writeFile(resolve(output,'experiment.json'),JSON.stringify(experiment,null,2),{flag:'wx'});
const rows=[];
for(let index=0;index<seeds;index++) for(let replicate=0;replicate<replicates;replicate++) for(const policy of policies) {
  const live=policy.startsWith('jev:'), difficulty=live?policy.slice(4):policy==='expectimax'?'normal':'easy';
  const seed=await sha256(`${experiment.baseSeed}:${split}:${index}`);
  const matchId=(await sha256(`${seed}:${replicate}:${policy}`)).slice(0,32);
  const folder=resolve(output,`${String(index).padStart(4,'0')}-${replicate}-${policy.replace(':','-')}`);await mkdir(folder,{recursive:true});
  const manifest={schemaVersion:1,matchId,game:'2048',rulesVersion:RULES_VERSION,rngVersion:RNG_VERSION,policyVersion:POLICY_VERSION,
    difficulty,profile:PROFILES[difficulty],model:live?(process.env.JEV_MODEL||DEFAULT_MODEL):null,moveLimit,
    mode:live?'jev':'local',ranked:false,createdAt:new Date().toISOString(),evidenceClass:live?'live-provider-benchmark':'scripted-baseline-benchmark',
    build:BUILD_INFO,experiment:{split,seedIndex:index,replicate,policy,baseline}};
  const initial=await initialCells(seed),commitment=await seedCommitment(manifest,seed),events=[];
  let state=createDuel(initial,{matchId,moveLimit}),failed=null;
  const journal=await open(resolve(folder,'events.jsonl'),'wx');
  async function emit(type,data) {
    const created=await createEvents(events.at(-1),[{type,data}],{matchId,clockId:matchId});
    await journal.write(created.map(e=>JSON.stringify(e)).join('\n')+'\n');await journal.sync();events.push(...created);
  }
  const randomHuman=randomGenerator(parseInt(seed.slice(0,8),16)),randomOpponent=randomGenerator(parseInt(seed.slice(8,16),16)+replicate);
  const start=performance.now();
  try {
    await emit('match_started',{manifest,initialCells:initial,commitment});
    while(state.status==='active') {
      const humanAction=state.human.status==='playing'?baselineAction(state.human,baseline,randomHuman):null;
      await emit('round_reserved',{requestId:`bench-${state.round}`,humanAction,expectedRevision:state.revision});
      let decision;
      if(state.jev.status!=='playing')decision={action:null,source:'finished',candidates:[],latencyMs:0};
      else if(live)decision=await chooseJevAction({board:state.jev,difficulty,model:manifest.model,apiKey:process.env.TYPESAFE_API_KEY,
        remainingMoves:moveLimit-state.jev.moves,emit});
      else {
        const t=performance.now(),candidates=generateCandidates(state.jev,difficulty);
        decision={action:baselineAction(state.jev,policy,randomOpponent),source:'scripted',baseline:policy,candidates,
          latencyMs:performance.now()-t,confidence:null,usage:null};
        await emit('candidates_generated',{candidates,stateHash:await sha256(state.jev),difficulty});
      }
      await emit('decision_selected',{action:decision.action,source:decision.source,stateHash:await sha256(state.jev)});
      const spawnEvent=await deriveSpawn(seed,state.round),applied=advanceRound(state,{humanAction,jevAction:decision.action,spawnEvent});
      await emit('round_committed',{actions:{human:humanAction,jev:decision.action},state:applied.state,spawnEvent,
        details:applied.details,decision,humanCandidates:state.human.status==='playing'?generateCandidates(state.human,'easy'):[],
        preStateHash:await sha256(state),postStateHash:await sha256(applied.state)});state=applied.state;
    }
  }catch(error){failed=error.code||error.message;await emit('run_failed',{code:failed});}
  finally{await journal.close();}
  const bundle={formatVersion:1,manifest,commitment,seed,finalState:state,status:state.status,head:events.at(-1).hash,events,telemetry:[]};
  const verification=await verifyBundle(bundle),analytics=analyze(bundle);
  await writeFile(resolve(folder,'audit.json'),JSON.stringify(bundle));
  await writeFile(resolve(folder,'analytics.json'),JSON.stringify(analytics));
  const row={policy,baseline,seedIndex:index,replicate,split,complete:state.status==='complete',failed,
    score:state.jev.score,baselineScore:state.human.score,pairedDifference:state.jev.score-state.human.score,
    maxTile:2**Math.max(...state.jev.cells),moves:state.jev.moves,capHit:state.jev.status==='move_cap',
    liveProviderDecisions:analytics.model.decisions,providerRequests:analytics.model.requests,
    knownInputTokens:analytics.model.usage.inputTokensKnown,unknownUsageAttempts:analytics.model.usage.attemptsWithoutUsage,
    latencyP50:analytics.model.decisionLatencyMs.p50,latencyP95:analytics.model.decisionLatencyMs.p95,
    wallMs:performance.now()-start,chainVerified:verification.ok};
  rows.push(row);console.log(JSON.stringify(row));
}
const bootstrapRandom=randomGenerator(2048),summaries=[];
for(const policy of policies) {
  const all=rows.filter(r=>r.policy===policy),valid=all.filter(r=>r.complete&&!r.failed);
  const perSeed=[...new Set(valid.map(r=>r.seedIndex))].map(index=>average(valid.filter(r=>r.seedIndex===index).map(r=>r.pairedDifference)));
  const bootstrap=[];
  if(perSeed.length>=2)for(let b=0;b<2000;b++)bootstrap.push(average(perSeed.map(()=>perSeed[Math.floor(bootstrapRandom()*perSeed.length)])));
  summaries.push({policy,runs:all.length,completed:valid.length,failed:all.filter(r=>r.failed).length,
    meanScore:average(valid.map(r=>r.score)),medianScore:quantile(valid.map(r=>r.score),.5),
    reached2048Rate:average(valid.map(r=>Number(r.maxTile>=2048))),capHitRate:average(valid.map(r=>Number(r.capHit))),
    pairedDifferenceMean:average(perSeed),pairedBootstrap95CI:bootstrap.length?[quantile(bootstrap,.025),quantile(bootstrap,.975)]:null,
    independentSeedCount:perSeed.length,providerCalls:all.reduce((s,r)=>s+r.providerRequests,0)});
}
const report={experiment,summaries,rows,caveats:[
  'Bootstrap intervals resample seed-level means; repeated moves are not independent samples.',
  'These are descriptive intervals, not a confirmatory statistical test.',
  'Move-cap results are censored marathon performance. Compare only identical rule caps.',
  'Failed runs remain in the report and are excluded from completed-score aggregates.',
  'No JEV performance claim is supported by scripted-baseline runs.']};
await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await writeFile(resolve(output,'runs.csv'),csv(rows));
console.log(`Report written: ${output}`);
