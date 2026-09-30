import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './http-fixture.js';
import {handleApi,HEADERS} from '../server/app.js';
import {documentHeaders,ACTIVITY_FRAME_ANCESTORS} from '../server/activity.js';
import worker from '../server/worker.js';
const APP='123456789012345678',ACTIVITY=`https://${APP}.discordsays.com`;
function discordFetch(calls=[]) {
  return async(url,options)=>{
    calls.push({url,body:options?.body?String(options.body):null});
    if(String(url).endsWith('/oauth2/token'))return Response.json({access_token:'fixture-access'});
    if(String(url).endsWith('/users/@me'))return Response.json({id:'223344556677889900',username:'player',global_name:'Player One',avatar:null});
    throw new Error(`unexpected fetch ${url}`);
  };
}
const setup=(extra={})=>fixture({DISCORD_CLIENT_ID:APP,DISCORD_CLIENT_SECRET:'fixture-secret',...extra});
// Raw requests so that origin and authorization are fully controlled by each case.
const raw=(f,path,{method='GET',origin,headers={},body}={})=>handleApi(new Request(f.env.PUBLIC_ORIGIN+path,{method,
  headers:{...(origin?{origin}:{}),'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env);
const start=async(f,code='c')=>(await raw(f,'/api/activity/session',{method:'POST',origin:ACTIVITY,body:{code}})).json();
const bearer=s=>({authorization:`Bearer ${s.token}`});
test('activity config exposes only the public client id and needs Discord configured',async()=>{
  const f=await setup();
  try {const r=await raw(f,'/api/activity/config');assert.equal(r.status,200);assert.deepEqual(await r.json(),{clientId:APP});}
  finally {f.DB.close();}
  const bare=await fixture();
  try {assert.equal((await raw(bare,'/api/activity/config')).status,503);} finally {bare.DB.close();}
});
test('an SDK code becomes a bearer session: exchanged without a redirect uri, token is not stored in clear',async()=>{
  const calls=[],f=await setup({FETCH:discordFetch(calls)});
  try {
    const r=await raw(f,'/api/activity/session',{method:'POST',origin:ACTIVITY,body:{code:'sdk-code'}});assert.equal(r.status,200);
    const s=await r.json();assert.match(s.token,/^[a-f0-9]{64}$/);assert.match(s.csrf,/^[a-f0-9]{64}$/);assert.equal(s.accessToken,'fixture-access');assert.equal(s.user.displayName,'Player One');
    const exchange=new URLSearchParams(calls[0].body);assert.equal(exchange.get('grant_type'),'authorization_code');assert.equal(exchange.get('code'),'sdk-code');assert.equal(exchange.has('redirect_uri'),false);
    assert.equal(r.headers.get('set-cookie'),null,'no cookie is set inside an Activity');
    assert.equal(await f.DB.prepare('SELECT 1 AS x FROM sessions WHERE id=?').bind(s.token).first(),null,'the raw token must not be stored');
    assert.ok(await f.DB.prepare('SELECT 1 AS x FROM users WHERE id=?').bind('223344556677889900').first());
  } finally {f.DB.close();}
});
test('the bearer session works for reads and for mutations from the activity origin',async()=>{
  const f=await setup({FETCH:discordFetch()});
  try {
    const s=await start(f),me=await (await raw(f,'/api/me',{headers:bearer(s)})).json();assert.equal(me.user.display_name,'Player One');assert.equal(me.csrf,s.csrf);
    const out=await raw(f,'/api/logout',{method:'POST',origin:ACTIVITY,headers:{...bearer(s),'x-csrf-token':s.csrf},body:{}});assert.equal(out.status,200);
    assert.equal((await (await raw(f,'/api/me',{headers:bearer(s)})).json()).user,null,'logout removed the bearer session');
  } finally {f.DB.close();}
});
test('the activity origin is accepted only together with a bearer session',async()=>{
  const f=await setup({FETCH:discordFetch()});
  try {
    const s=await start(f),cookieOnly=await raw(f,'/api/me'),cookie=cookieOnly.headers.get('set-cookie').split(';')[0],me=await cookieOnly.json();
    const post=(origin,headers)=>raw(f,'/api/logout',{method:'POST',origin,headers,body:{}});
    assert.equal((await post(ACTIVITY,{cookie,'x-csrf-token':me.csrf})).status,403,'cookie session must not be usable from the discordsays origin');
    assert.equal((await post('https://evil.example',{...bearer(s),'x-csrf-token':s.csrf})).status,403);
    assert.equal((await post('https://999999999999999999.discordsays.com',{...bearer(s),'x-csrf-token':s.csrf})).status,403,'another application\'s discordsays origin is not ours');
    assert.equal((await post(ACTIVITY,bearer(s))).status,403,'missing csrf');
    assert.equal((await post(ACTIVITY,{...bearer(s),'x-csrf-token':me.csrf})).status,403,'another session\'s csrf');
  } finally {f.DB.close();}
});
test('session creation rejects foreign origins, missing codes, unknown fields and Discord failures',async()=>{
  const f=await setup({FETCH:discordFetch()}),session=(origin,body)=>raw(f,'/api/activity/session',{method:'POST',origin,body});
  try {
    assert.equal((await session('https://evil.example',{code:'c'})).status,403);
    assert.equal((await session(undefined,{code:'c'})).status,403);
    assert.equal((await session(ACTIVITY,{})).status,400);
    assert.equal((await session(ACTIVITY,{code:'x'.repeat(3000)})).status,400);
    assert.equal((await session(ACTIVITY,{code:'c',extra:1})).status,400);
    assert.equal((await raw(f,'/api/me',{headers:{authorization:'Bearer nothex'}})).status,200,'a malformed bearer is ignored and a fresh anonymous session is created');
  } finally {f.DB.close();}
  const failing=await setup({FETCH:async()=>new Response('no',{status:400})});
  try {assert.equal((await raw(failing,'/api/activity/session',{method:'POST',origin:ACTIVITY,body:{code:'c'}})).status,502);} finally {failing.DB.close();}
});
test('only a page loaded with frame_id may be framed, and only by Discord',async()=>{
  const url=s=>new URL('https://2048.jevplay.games'+s),plain=documentHeaders(url('/'),HEADERS),framed=documentHeaders(url('/?frame_id=1&instance_id=2'),HEADERS);
  assert.match(plain['Content-Security-Policy'],/frame-ancestors 'none'/);assert.equal(plain['X-Frame-Options'],undefined);
  const csp=framed['Content-Security-Policy'];assert.ok(csp.includes(ACTIVITY_FRAME_ANCESTORS));assert.ok(!csp.includes("frame-ancestors 'none'"));assert.equal(framed['X-Frame-Options'],undefined);
  assert.match(csp,/script-src 'self'/);assert.match(csp,/connect-src 'self'/);assert.match(csp,/form-action 'self' https:\/\/discord.com/,'the rest of the policy is unchanged');
  assert.ok(!/discordsays/.test(csp));
  const f=await setup();
  try {const api=await raw(f,'/api/activity/config?frame_id=1');assert.match(api.headers.get('content-security-policy'),/frame-ancestors 'none'/,'API responses are never frameable');}
  finally {f.DB.close();}
});
test('the Worker applies the framing headers to the document only when frame_id is present',async()=>{
  const env={ASSETS:{fetch:async()=>new Response('<html></html>',{headers:{'Content-Type':'text/html'}})}};
  const plain=await worker.fetch(new Request('https://2048.jevplay.games/'),env),framed=await worker.fetch(new Request('https://2048.jevplay.games/?frame_id=1'),env);
  assert.match(plain.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.ok(framed.headers.get('content-security-policy').includes(ACTIVITY_FRAME_ANCESTORS));assert.equal(framed.headers.get('x-frame-options'),null);
});
