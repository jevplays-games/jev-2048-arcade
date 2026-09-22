import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze,distribution,quantile} from '../public/core/analytics.js';
import {verifyBundle} from '../public/core/audit.js';
import {fixture} from './http-fixture.js';
import {getLegalActions} from '../public/core/rules.js';
test('partial usage preserves known input without inventing missing output or timed-out usage',()=>{
  const report=analyze({events:[
    {seq:1,type:'jev_requested',data:{requestHash:'a',attempt:1}},
    {seq:2,type:'jev_response',data:{requestHash:'a',httpStatus:200,latencyMs:12,response:{usage:{input_tokens:100}}}},
    {seq:3,type:'jev_requested',data:{requestHash:'b',attempt:1}},
    {seq:4,type:'jev_failed',data:{requestHash:'b',code:'jev_network',latencyMs:15}}
  ]});
  assert.equal(report.model.requests,2);assert.equal(report.model.usage.inputTokensKnown,100);
  assert.equal(report.model.usage.attemptsWithoutUsage,2);assert.equal(report.model.usage.complete,false);
  assert.equal(report.model.usage.attemptsWithKnownOutput,0);assert.equal(report.model.estimatedCostUSD,null);
});
test('empty distributions remain unknown, and percentiles use linear interpolation',()=>{
  assert.equal(distribution([]).mean,null);assert.equal(distribution([]).p95,null);
  assert.equal(quantile([0,10],.95),9.5);assert.equal(distribution([NaN,4]).count,1);
});
test('streamed verification matches an array and rejects a truncated trusted snapshot',async()=>{
  const f=await fixture({TEST_MOVE_LIMIT:'1'});
  try{
    let m=(await f.call('/api/matches','POST',{mode:'local',difficulty:'easy',ranked:false})).body.match;
    m=(await f.call(`/api/matches/${m.id}/step`,'POST',{requestId:'stream-test-request',expectedRevision:0,humanAction:getLegalActions(m.state.human)[0]})).body.match;
    const bundle=(await f.call(`/api/matches/${m.id}/bundle`)).body;
    async function* stream(){for(const event of bundle.events)yield event;}
    assert.deepEqual(await verifyBundle({...bundle,events:stream()}),await verifyBundle(bundle));
    const truncated={...bundle,events:bundle.events.slice(0,-1)};
    await assert.rejects(()=>verifyBundle(truncated),/head mismatch/);
    const a=analyze(bundle);assert.equal(a.roundRows.length,2);assert.equal(a.cellRows.length,32);
    for(const actor of Object.values(a.actors)){
      assert.equal(actor.spawn2+actor.spawn4,actor.moves);
      assert.equal(actor.actions.reduce((sum,n)=>sum+n,0),actor.moves);
    }
  }finally{f.DB.close();}
});
