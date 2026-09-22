import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './http-fixture.js';
import {fakeResponse} from './provider-fixture.js';
import {getLegalActions} from '../public/core/rules.js';
import {sha256, signToken, hex} from '../public/core/crypto.js';
import {handleApi} from '../server/app.js';
import {partition} from '../server/matches.js';
import {RULES_VERSION} from '../public/core/rules.js';
import {POLICY_VERSION} from '../public/core/evaluate.js';
import {csv} from '../public/core/analytics.js';
async function login(f) {
  const start=await f.call('/api/auth/discord');assert.equal(start.status,302);
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  const result=await f.call('/api/auth/discord/callback?code=fixture-code&state='+state);assert.equal(result.status,302);
  const me=await f.call('/api/me');assert.equal(me.body.user.id,'123456789001');return {state,me:me.body};
}
function discordFetch(url,options) {
  if(url.endsWith('/oauth2/token'))return Promise.resolve(Response.json({access_token:'fixture-access-token'}));
  if(url.endsWith('/users/@me'))return Promise.resolve(Response.json({id:'123456789001',global_name:'Fixture Player',avatar:null}));
  return Promise.resolve(Response.json(fakeResponse(JSON.parse(options.body))));
}
test('OAuth state is browser-bound, one-use; session rotates; guest cannot become ranked retroactively',async()=>{
  const f=await fixture({DISCORD_CLIENT_ID:'fixture-client',DISCORD_CLIENT_SECRET:'fixture-secret',FETCH:discordFetch});
  try {
    const original=f.context().cookie;
    const guest=(await f.call('/api/matches','POST',{mode:'local',difficulty:'easy',ranked:false})).body.match;
    const {state}=await login(f);assert.notEqual(f.context().cookie,original);
    const resumed=await f.call('/api/matches/'+guest.id);assert.equal(resumed.status,200);assert.equal(resumed.body.match.ranked,false);
    const replay=await f.call('/api/auth/discord/callback?code=fixture-code&state='+state);assert.equal(replay.status,403);
  } finally {f.DB.close();}
});
test('wrong OAuth state is rejected before contacting Discord',async()=>{
  let called=false;const f=await fixture({DISCORD_CLIENT_ID:'x',DISCORD_CLIENT_SECRET:'y',FETCH:async()=>{called=true;throw Error('should not call');}});
  try {assert.equal((await f.call('/api/auth/discord/callback?code=x&state='+'ab'.repeat(32))).status,403);assert.equal(called,false);}
  finally {f.DB.close();}
});
test('signed channel launches bind the user and cannot be replayed',async()=>{
  const f=await fixture({DISCORD_CLIENT_ID:'x',DISCORD_CLIENT_SECRET:'y',FETCH:discordFetch});
  try {
    await login(f);
    const payload={v:1,aud:'jev-2048',sub:'123456789001',guildId:'55555555555',channelId:'66666666666',nonce:'ab'.repeat(16),exp:Date.now()+300000};
    const token=await signToken(f.env.APP_SIGNING_KEY,payload);
    const accepted=await f.call('/api/context','POST',{launchToken:token});assert.equal(accepted.status,200);
    assert.equal(accepted.body.context.channelId,payload.channelId);
    assert.equal((await f.call('/api/context','POST',{launchToken:token})).status,409);
    const wrong=await signToken(f.env.APP_SIGNING_KEY,{...payload,sub:'987654321000',nonce:'ac'.repeat(16)});
    assert.equal((await f.call('/api/context','POST',{launchToken:wrong})).status,403);
  } finally {f.DB.close();}
});
test('Discord Ed25519 signature verifies exact bytes, timestamp, and approved channel',async()=>{
  const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const publicKey=hex(new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey)));
  const f=await fixture({DISCORD_PUBLIC_KEY:publicKey,DISCORD_ALLOWED_CHANNELS:'55555555555:66666666666'});
  async function signed(data,timestamp=String(Math.floor(Date.now()/1000)),tamper=false) {
    const text=JSON.stringify(data);const signature=hex(new Uint8Array(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+text))));
    const response=await handleApi(new Request('http://localhost/api/discord/interactions',{method:'POST',
      headers:{'content-type':'application/json','x-signature-timestamp':timestamp,'x-signature-ed25519':signature},body:text+(tamper?' ': '')}),f.env);
    return {status:response.status,body:await response.json()};
  }
  try {
    assert.equal((await signed({type:1})).body.type,1);
    assert.equal((await signed({type:1},undefined,true)).status,401);
    assert.equal((await signed({type:1},String(Math.floor(Date.now()/1000)-600))).status,401);
    const interaction={id:'123123123123',type:2,data:{name:'2048'},guild_id:'55555555555',channel_id:'66666666666',channel:{type:0},member:{user:{id:'123456789001'}}};
    const result=await signed(interaction);assert.equal(result.status,200);assert.ok(result.body.data.components[0].components[0].url.includes('#launch='));
    assert.equal((await signed(interaction)).status,409);
  } finally {f.DB.close();}
});
test('concurrent steps apply once; no lease loser can replace the human action',async()=>{
  let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const f=await fixture({TYPESAFE_API_KEY:'fixture',FETCH:async(_url,options)=>{entered();await gate;return Response.json(fakeResponse(JSON.parse(options.body)));}});
  try {
    const m=(await f.call('/api/matches','POST',{mode:'jev',difficulty:'easy',ranked:false})).body.match;
    const request={requestId:'concurrent-request-one',expectedRevision:0,humanAction:getLegalActions(m.state.human)[0]};
    const first=f.call('/api/matches/'+m.id+'/step','POST',request);await ready;
    const second=await f.call('/api/matches/'+m.id+'/step','POST',{...request,requestId:'concurrent-request-two'});
    assert.equal(second.status,409);release();assert.equal((await first).status,200);
    const snapshot=(await f.call('/api/matches/'+m.id)).body.match;assert.equal(snapshot.state.round,1);
    const count=f.DB.raw.prepare("SELECT COUNT(*) n FROM events WHERE match_id=? AND type='round_committed'").get(m.id);assert.equal(count.n,1);
  } finally {f.DB.close();}
});
test('ranked native fixture completes verification and inserts exactly one result',async()=>{
  const f=await fixture({TEST_MOVE_LIMIT:'1',TYPESAFE_API_KEY:'fixture',DISCORD_CLIENT_ID:'x',DISCORD_CLIENT_SECRET:'y',FETCH:discordFetch});
  try {
    await login(f);
    const m=(await f.call('/api/matches','POST',{mode:'jev',difficulty:'easy',ranked:true})).body.match;
    const body={requestId:'ranked-native-fixture',expectedRevision:0,humanAction:getLegalActions(m.state.human)[0]};
    const response=await f.call('/api/matches/'+m.id+'/step','POST',body);assert.equal(response.status,200,JSON.stringify(response.body));
    assert.equal(response.body.match.verified,true);assert.equal(response.body.match.ranked,true);
    await f.call('/api/matches/'+m.id+'/step','POST',body);
    assert.equal(f.DB.raw.prepare('SELECT COUNT(*) n FROM results WHERE match_id=?').get(m.id).n,1);
  } finally {f.DB.close();}
});
test('leaderboard best-per-user, competition ties, pagination and community isolation',async()=>{
  const f=await fixture();try {
    const key=partition({rulesVersion:RULES_VERSION,difficulty:'normal',policyVersion:POLICY_VERSION,model:'jev-1.13.0',moveLimit:2048});
    const base=(await f.call('/api/matches','POST',{mode:'local',difficulty:'easy',ranked:false})).body.match;
    await f.call('/api/matches/'+base.id+'/control','POST',{action:'resign'});
    // Direct database fixtures exercise read queries, not the trusted score-writing path.
    for(const [i,score,guild,channel] of [[1,500,'guild-a','channel-a'],[2,500,'guild-a','channel-b'],[3,400,'guild-b','channel-c']]) {
      const id='fixture-user-'+i,matchId=String(i).repeat(32);
      f.DB.raw.prepare('INSERT INTO users VALUES(?,?,NULL,?,?)').run(id,'Player '+i,Date.now(),Date.now());
      f.DB.raw.prepare(`INSERT INTO matches(id,session_id,user_id,manifest_json,commitment,seed_cipher,state_json,revision,ranked,mode,guild_id,channel_id,status,created_at,expires_at,event_head)
        SELECT ?,?,?,manifest_json,commitment,seed_cipher,state_json,0,1,'jev',?,?,'complete',created_at,expires_at,event_head FROM matches WHERE id=?`).run(matchId,'fixture-session-'+i,id,guild,channel,base.id);
      f.DB.raw.prepare('INSERT INTO results VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(matchId,id,key,guild,channel,score,400,64,80,'WIN','0'.repeat(64),Date.now()+i);
    }
    const world=(await f.call('/api/leaderboards?scope=world&limit=2')).body;
    assert.deepEqual(world.entries.map(e=>e.rank),[1,1]);assert.equal(world.nextOffset,2);
    const next=(await f.call('/api/leaderboards?scope=world&offset=2')).body;assert.equal(next.entries[0].rank,3);
    assert.equal((await f.call('/api/leaderboards?scope=channel')).status,403);
    const sessionId=f.DB.raw.prepare('SELECT id FROM sessions').get().id;
    f.DB.raw.prepare('UPDATE sessions SET user_id=?,context_json=? WHERE id=?').run('fixture-user-1',JSON.stringify({subject:'fixture-user-1',guildId:'guild-a',channelId:'channel-a',expiresAt:Date.now()+60000}),sessionId);
    assert.equal((await f.call('/api/leaderboards?scope=channel')).body.entries.length,1);
    assert.equal((await f.call('/api/leaderboards?scope=server')).body.entries.length,2);
  }finally{f.DB.close();}
});
test('CSV export neutralizes formula injection in text, not numeric negatives',()=>{
  const output=csv([{name:'=HYPERLINK("x")',difference:-12}]);assert.ok(output.includes("'=HYPERLINK"));assert.ok(output.includes('"-12"'));
});
test('schema write batches roll back atomically when an event guard fails',async()=>{
  const f=await fixture();try {
    const m=(await f.call('/api/matches','POST',{mode:'local',difficulty:'easy',ranked:false})).body.match;
    await assert.rejects(()=>f.DB.batch([
      f.DB.prepare('UPDATE matches SET revision=99 WHERE id=?').bind(m.id),
      f.DB.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').bind(m.id,9,'bad','{}','0'.repeat(64),'0'.repeat(64))
    ]));
    assert.equal(f.DB.raw.prepare('SELECT revision FROM matches WHERE id=?').get(m.id).revision,0);
  }finally{f.DB.close();}
});
