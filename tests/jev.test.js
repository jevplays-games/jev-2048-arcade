import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseJevAction,validateResponse,buildRequest} from '../server/jev.js';
import {generateCandidates} from '../public/core/evaluate.js';
import {makeBoard,getLegalActions} from '../public/core/rules.js';
import {fakeResponse} from './provider-fixture.js';

const board=makeBoard([1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]);
test('typed JEV request limits knowledge and records native evidence',async()=>{
  const events=[];
  const out=await chooseJevAction({board,difficulty:'easy',apiKey:'test-not-a-real-key',
    fetcher:async(url,options)=>{
      assert.equal(url,'https://api.typesafe.ai/v1/systemone');
      const request=JSON.parse(options.body);assert.equal(request.state.human,undefined);
      assert.equal(request.state.seed,undefined);return Response.json(fakeResponse(request));
    },emit:async(type,data)=>events.push({type,data})});
  assert.equal(out.source,'jev');assert.ok(getLegalActions(board).includes(out.action));
  assert.equal(events.filter(e=>e.type==='jev_requested').length,1);
  assert.ok(!JSON.stringify(events).includes('test-not-a-real-key'));
});
test('malformed probability, missing answers and wrong model rejected',()=>{
  const request=buildRequest(board,generateCandidates(board,'easy'),'easy','jev-1.13.0',100);
  const a=fakeResponse(request);a.model='other';assert.throws(()=>validateResponse(a,request));
  const b=fakeResponse(request);delete b.answers[Object.keys(b.answers)[0]];assert.throws(()=>validateResponse(b,request));
  const c=fakeResponse(request);Object.values(c.answers)[0].probabilities['0']=1;assert.throws(()=>validateResponse(c,request));
});
test('no key never silently substitutes',async()=>{
  await assert.rejects(()=>chooseJevAction({board,difficulty:'easy'}),/not configured/);
  const out=await chooseJevAction({board,difficulty:'easy',mode:'local'});assert.equal(out.source,'heuristic');
  assert.equal(out.confidence,null);assert.equal(out.usage,null);
});
test('transient failure retries once and records both attempts',async()=>{
  let calls=0;const events=[];
  const out=await chooseJevAction({board,difficulty:'easy',apiKey:'fixture',fetcher:async(_url,options)=>{
    calls++;return calls===1?Response.json({message:'overloaded'},{status:529}):Response.json(fakeResponse(JSON.parse(options.body)));
  },emit:async(type,data)=>events.push({type,data})});
  assert.equal(calls,2);assert.equal(out.retryCount,1);assert.equal(events.filter(e=>e.type==='jev_response').length,2);
});
test('permanent failure stays unavailable and cannot become a legal move',async()=>{
  let calls=0;
  await assert.rejects(()=>chooseJevAction({board,difficulty:'easy',apiKey:'fixture',fetcher:async()=>{
    calls++;return Response.json({error:'unauthorized'},{status:401});
  }}));assert.equal(calls,1);
});
