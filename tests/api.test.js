import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSqlite} from '../server/sqlite.js';
import {handleApi} from '../server/app.js';
import {getLegalActions} from '../public/core/rules.js';
import {verifyBundle} from '../public/core/audit.js';
import {analyze} from '../public/core/analytics.js';
import {fakeResponse} from './provider-fixture.js';
import {fixture} from './http-fixture.js';

test('local end-to-end match, idempotency, immutable log, analytics and tamper detection',async()=>{
  const f=await fixture();try{
    let r=await f.call('/api/matches','POST',{difficulty:'easy',mode:'local',ranked:false});
    assert.equal(r.status,201,JSON.stringify(r.body));let m=r.body.match;
    const active=await f.call(`/api/matches/${m.id}/bundle`);assert.equal(active.body.seed,null);
    for(let i=0;i<3;i++) {
      const body={requestId:`request-fixture-${i}`,expectedRevision:m.state.revision,humanAction:getLegalActions(m.state.human)[0]};
      r=await f.call(`/api/matches/${m.id}/step`,'POST',body);assert.equal(r.status,200,JSON.stringify(r.body));m=r.body.match;
      const duplicate=await f.call(`/api/matches/${m.id}/step`,'POST',body);
      assert.equal(duplicate.status,200);assert.equal(duplicate.body.match.state.revision,m.state.revision);
    }
    assert.equal(m.status,'complete');assert.equal(m.verified,true);
    const exported=await f.call(`/api/matches/${m.id}/bundle`);assert.ok(exported.body.seed);
    const report=await verifyBundle(exported.body,{requireComplete:true});assert.equal(report.rounds,3);
    const analytics=analyze(exported.body);assert.equal(analytics.actors.human.moves,3);assert.equal(analytics.roundRows.length,6);
    assert.equal(analytics.model.decisions,0);assert.ok(analytics.cellRows.length===96);
    const corrupted=structuredClone(exported.body);corrupted.events[1].data.humanAction=99;
    await assert.rejects(()=>verifyBundle(corrupted),/hash/);
    assert.equal((await f.call('/api/leaderboards')).body.entries.length,0);
  }finally{f.DB.close();}
});
test('CSRF, illegal moves, unknown fields, ranked guest and cross-session access rejected',async()=>{
  const f=await fixture();try{
    assert.equal((await f.call('/api/matches','POST',{difficulty:'easy',mode:'local',ranked:false},{'x-csrf-token':'wrong'})).status,403);
    assert.equal((await f.call('/api/matches','POST',{difficulty:'easy',mode:'local',ranked:true})).status,403);
    assert.equal((await f.call('/api/matches','POST',{difficulty:'easy',mode:'local',ranked:false,score:999999})).status,400);
    const m=(await f.call('/api/matches','POST',{difficulty:'easy',mode:'local',ranked:false})).body.match;
    assert.equal((await f.call(`/api/matches/${m.id}/step`,'POST',{requestId:'bad-direction-id',expectedRevision:0,humanAction:null})).status,422);
    const stranger=await handleApi(new Request('http://localhost/api/me'),f.env);const session=await stranger.json();
    const res=await handleApi(new Request(`http://localhost/api/matches/${m.id}`,{headers:{cookie:stranger.headers.get('set-cookie').split(';')[0]}}),f.env);
    assert.equal(res.status,404);assert.ok(session.csrf);
  }finally{f.DB.close();}
});
test('native JEV fixture evidence replays without network',async()=>{
  let calls=0;
  const f=await fixture({TYPESAFE_API_KEY:'fixture',FETCH:async(_url,options)=>{calls++;return Response.json(fakeResponse(JSON.parse(options.body)));}});
  try{
    let m=(await f.call('/api/matches','POST',{difficulty:'easy',mode:'jev',ranked:false})).body.match;
    for(let i=0;i<3;i++) {
      const r=await f.call(`/api/matches/${m.id}/step`,'POST',{requestId:'native-request-'+i,expectedRevision:m.state.revision,humanAction:getLegalActions(m.state.human)[0]});
      assert.equal(r.status,200,JSON.stringify(r.body));m=r.body.match;
    }
    const bundle=(await f.call(`/api/matches/${m.id}/bundle`)).body, before=calls;
    const report=await verifyBundle(bundle,{requireComplete:true});assert.equal(calls,before);assert.ok(report.nativeDecisions>0);
    assert.equal(analyze(bundle).model.usage.inputTokensKnown,calls*512);
  }finally{f.DB.close();}
});
test('provider failures keep the action locked until explicit practice downgrade',async()=>{
  const f=await fixture({TYPESAFE_API_KEY:'fixture',FETCH:async()=>Response.json({error:'no'},{status:401})});
  try{
    let m=(await f.call('/api/matches','POST',{difficulty:'easy',mode:'jev',ranked:false})).body.match;
    const body={requestId:'retry-locked-action',expectedRevision:0,humanAction:getLegalActions(m.state.human)[0]};
    const failed=await f.call(`/api/matches/${m.id}/step`,'POST',body);assert.equal(failed.status,503);
    m=(await f.call(`/api/matches/${m.id}`)).body.match;assert.equal(m.state.revision,0);assert.ok(m.pending);
    assert.equal((await f.call(`/api/matches/${m.id}/control`,'POST',{action:'continue_practice'})).status,200);
    const resumed=await f.call(`/api/matches/${m.id}/step`,'POST',body);assert.equal(resumed.status,200);
    assert.equal(resumed.body.match.mode,'local');assert.equal(resumed.body.decision.source,'heuristic');
  }finally{f.DB.close();}
});
