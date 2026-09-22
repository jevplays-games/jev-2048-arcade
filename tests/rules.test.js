import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateMove, getLegalActions, advanceRound, createDuel, mass, canonical, applySpawn, spawnFor, lineIndices} from '../public/core/rules.js';
import {initialCells, deriveSpawn, sha256, encrypt, decrypt, seedCommitment, signToken, verifyToken} from '../public/core/crypto.js';
import {boardFeatures, chanceOutcomes, generateCandidates, lookahead} from '../public/core/evaluate.js';
const cells = values => [...values.map(x => x ? Math.log2(x) : 0), ...Array(16-values.length).fill(0)];
for (const [from, to, score] of [
  [[2,2,2,2],[4,4,0,0],8], [[2,2,4,0],[4,4,0,0],4], [[4,4,4,0],[8,4,0,0],8],
  [[2,0,2,2],[4,2,0,0],4], [[2,2,4,4],[4,8,0,0],12], [[0,0,0,0],[0,0,0,0],0]
]) test(`merge ${from}`, () => {
  const input = cells(from), previous = input.slice(), move = simulateMove(input,3);
  assert.deepEqual(move.cells.slice(0,4), cells(to).slice(0,4)); assert.equal(move.scoreDelta,score);
  assert.deepEqual(input,previous); assert.equal(mass(move.cells),mass(input));
});
test('exhaust all 1,296 exponent lines in all directions, against an independent queue reference', () => {
  for (let encoded=0; encoded<6**4; encoded++) {
    let n=encoded; const input=[];
    for (let i=0;i<4;i++) {input.push(n%6);n=Math.floor(n/6);}
    const queue=input.filter(Boolean), expected=[]; let gain=0;
    while(queue.length) {
      const first=queue.shift();
      if(queue[0]===first){queue.shift();expected.push(first+1);gain+=2**(first+1);} else expected.push(first);
    }
    while(expected.length<4)expected.push(0);
    for(let action=0;action<4;action++) {
      const board=Array(16).fill(0), indices=lineIndices(action,2); indices.forEach((p,i)=>board[p]=input[i]);
      const out=simulateMove(board,action);
      assert.deepEqual(indices.map(i=>out.cells[i]),expected); assert.equal(out.scoreDelta,gain);
      assert.equal(mass(out.cells),mass(board));
    }
  }
});
test('blocked and full-but-mergeable states differ',()=>{
  const b=[1,2,1,2,2,1,2,1,1,2,1,2,2,1,2,1];assert.deepEqual(getLegalActions(b),[]);
  b[0]=2;assert.ok(getLegalActions(b).length);
});
test('invalid directions and malformed spawns are rejected',()=>{
  assert.throws(()=>simulateMove(Array(16).fill(0),4));
  assert.throws(()=>applySpawn(Array(16).fill(1),{cell:0,exponent:1}));
  assert.throws(()=>spawnFor(Array(16).fill(0),{order:Array(16).fill(0),exponent:1}));
});
test('both start identically; caps finish both; invalid direction consumes nothing',async()=>{
  const initial=await initialCells('ab'.repeat(32));
  const state=createDuel(initial,{moveLimit:1}), a=getLegalActions(initial)[0];
  const out=advanceRound(state,{humanAction:a,jevAction:a,spawnEvent:await deriveSpawn('ab'.repeat(32),0)});
  assert.deepEqual(out.state.human,out.state.jev);assert.equal(out.state.winner,'draw');
  assert.equal(out.state.status,'complete');assert.equal(state.round,0);
});
test('finished human board freezes while JEV continues',async()=>{
  const initial=await initialCells('cd'.repeat(32)),state=createDuel(initial);
  state.human.status='blocked';const before=canonical(state.human);
  const out=advanceRound(state,{humanAction:null,jevAction:getLegalActions(initial)[0],spawnEvent:await deriveSpawn('cd'.repeat(32),0)});
  assert.equal(canonical(out.state.human),before);assert.equal(out.details.human,null);
});
test('spawn vectors deterministic, uniform support, shared values and valid divergent positions',async()=>{
  const seed='ef'.repeat(32);const event=await deriveSpawn(seed,42);
  assert.deepEqual(event,await deriveSpawn(seed,42));assert.equal(new Set(event.order).size,16);
  const a=Array(16).fill(1),b=Array(16).fill(2);a[1]=0;b[10]=0;
  assert.equal(spawnFor(a,event).cell,1);assert.equal(spawnFor(b,event).cell,10);
  const counts=[0,0];
  for(let i=0;i<300;i++){const e=await deriveSpawn(seed,i);counts[e.exponent-1]++;}
  assert.ok(counts[1]>10&&counts[1]<60);
});
test('canonical hashing, encryption and signatures reject tampering',async()=>{
  assert.equal(await sha256({b:2,a:1}),await sha256({a:1,b:2}));
  const key='12'.repeat(32), sealed=await encrypt(key,'secret-seed');assert.equal(await decrypt(key,sealed),'secret-seed');
  await assert.rejects(()=>decrypt('13'.repeat(32),sealed));
  const token=await signToken(key,{exp:Date.now()+5000,value:5});assert.equal((await verifyToken(key,token)).value,5);
  await assert.rejects(()=>verifyToken(key,token.slice(0,-2)+'00'));
});
test('chance probabilities sum to one and feature/search budgets are bounded',()=>{
  const b=cells([2,4,8,16,32,64,128,256]);
  assert.ok(Math.abs(chanceOutcomes(b).reduce((s,c)=>s+c.probability,0)-1)<1e-10);
  const f=boardFeatures(b);assert.equal(f.emptyCount,8);assert.ok(f.monotonicity>=0&&f.monotonicity<=1);
  const search=lookahead(b,2,20);assert.ok(search.nodes<=20);assert.ok(search.truncated);
  const candidates=generateCandidates({cells:b},'normal');assert.equal(candidates.length,getLegalActions(b).length);
});
