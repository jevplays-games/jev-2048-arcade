// Renamed to Slide Score. Old hostnames, launch proofs, the /2048 command and audit bundles exported
// before the rename must keep working until (and after) the cutover.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {fixture} from './http-fixture.js';
import {signToken, hex} from '../public/core/crypto.js';
import {handleApi} from '../server/app.js';
import {appOrigins, LAUNCH_AUDIENCES, COMMAND_NAMES} from '../server/auth.js';
const NEW='https://slide-score.jevplay.games',OLD='https://2048.jevplay.games';
const hosts={PUBLIC_ORIGIN:NEW,LEGACY_PUBLIC_ORIGINS:OLD};
const discordFetch=url=>{
  if(String(url).endsWith('/oauth2/token'))return Promise.resolve(Response.json({access_token:'fixture-access-token'}));
  if(String(url).endsWith('/users/@me'))return Promise.resolve(Response.json({id:'123456789001',global_name:'Fixture Player',avatar:null}));
  throw new Error('unexpected fetch '+url);
};
// A browser on one host: host-only cookie, Origin header of that host.
function browser(f,origin) {
  let cookie='',csrf='';
  return async(path,method='GET',data,headers={})=>{
    const response=await handleApi(new Request(origin+path,{method,headers:{cookie,origin,'x-csrf-token':csrf,
      'content-type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})}),f.env);
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const text=await response.text(),body=text.startsWith('{')?JSON.parse(text):{};if(body.csrf)csrf=body.csrf;
    return {status:response.status,body,headers:response.headers};
  };
}
test('the Worker serves the new and the legacy hostname, and nothing else',async()=>{
  const f=await fixture(hosts);
  try {
    assert.deepEqual(appOrigins(f.env),[NEW,OLD]);
    for(const origin of [NEW,OLD]){const r=await browser(f,origin)('/api/health');assert.equal(r.status,200,origin);assert.equal(r.body.ok,true);}
    assert.equal((await browser(f,'https://evil.example')('/api/health')).status,421);
    assert.equal((await browser(f,'https://slide-score.jevplay.games.evil.example')('/api/health')).status,421);
  } finally {f.DB.close();}
});
test('legacy origins must be bare http(s) origins; credentials, paths, queries, fragments and non-URLs are skipped',async()=>{
  const warn=console.warn,warned=[];console.warn=m=>warned.push(m);
  try {
    assert.deepEqual(appOrigins({PUBLIC_ORIGIN:NEW,LEGACY_PUBLIC_ORIGINS:' https://2048.jevplay.games/ , https://2048.jevplay.games,,'}),[NEW,OLD]);
    assert.deepEqual(appOrigins({PUBLIC_ORIGIN:NEW,LEGACY_PUBLIC_ORIGINS:'2048.jevplay.games,not a url,javascript:alert(1),http://[::1'}),[NEW]);
    assert.equal(warned.length,4);assert.match(warned[0],/2048\.jevplay\.games/);
    // Each of these parses to a URL whose origin is not the host the operator meant; all must be skipped.
    const hostile=['https://user:pw@evil.example','https://evil.example#@2048.jevplay.games','https://2048.jevplay.games/some/path',
      'https://2048.jevplay.games/?x=1','https://2048.jevplay.games/#x','https://user@2048.jevplay.games'];
    for(const entry of hostile)assert.deepEqual(appOrigins({PUBLIC_ORIGIN:NEW,LEGACY_PUBLIC_ORIGINS:entry}),[NEW],entry);
    assert.equal(warned.length,4+hostile.length);
    const evil=await fixture({PUBLIC_ORIGIN:NEW,LEGACY_PUBLIC_ORIGINS:'https://user:pw@evil.example,https://evil.example#@2048.jevplay.games'});
    try {assert.equal((await browser(evil,'https://evil.example')('/api/health')).status,421);assert.equal((await browser(evil,NEW)('/api/health')).status,200);}
    finally {evil.DB.close();}
    const f=await fixture({PUBLIC_ORIGIN:NEW,LEGACY_PUBLIC_ORIGINS:'https://2048.jevplay.games/'});
    try {assert.equal((await browser(f,OLD)('/api/health')).status,200);assert.equal((await browser(f,'https://evil.example')('/api/health')).status,421);}
    finally {f.DB.close();}
  } finally {console.warn=warn;}
});
test('a write must come from the host it is sent to, on either hostname',async()=>{
  const f=await fixture(hosts);
  try {
    for(const origin of [NEW,OLD]){
      const call=browser(f,origin);await call('/api/me');
      assert.equal((await call('/api/matches','POST',{mode:'local',difficulty:'easy',ranked:false})).status,201,origin);
      const other=origin===NEW?OLD:NEW;
      assert.equal((await call('/api/matches','POST',{mode:'local',difficulty:'easy',ranked:false},{origin:other})).status,403,'cross-host write from '+other);
    }
  } finally {f.DB.close();}
});
test('Discord OAuth stays on the host the player started on',async()=>{
  const f=await fixture({...hosts,DISCORD_CLIENT_ID:'fixture-client',DISCORD_CLIENT_SECRET:'fixture-secret',FETCH:discordFetch});
  try {
    for(const origin of [NEW,OLD]){
      const call=browser(f,origin);await call('/api/me');
      const start=await call('/api/auth/discord');assert.equal(start.status,302);
      const location=new URL(start.headers.get('location'));
      assert.equal(location.searchParams.get('redirect_uri'),origin+'/api/auth/discord/callback');
      const done=await call('/api/auth/discord/callback?code=fixture-code&state='+location.searchParams.get('state'));
      assert.equal(done.status,302);assert.equal(done.headers.get('location'),origin+'/');
      assert.equal((await call('/api/me')).body.user.id,'123456789001');
    }
  } finally {f.DB.close();}
});
test('launch proofs with the original jev-2048 audience and the new jev-slide-score audience both verify',async()=>{
  assert.deepEqual(LAUNCH_AUDIENCES,['jev-2048','jev-slide-score'],'new proofs keep the original audience');
  const f=await fixture({...hosts,DISCORD_CLIENT_ID:'fixture-client',DISCORD_CLIENT_SECRET:'fixture-secret',FETCH:discordFetch});
  try {
    const call=browser(f,NEW);await call('/api/me');
    const state=new URL((await call('/api/auth/discord')).headers.get('location')).searchParams.get('state');
    await call('/api/auth/discord/callback?code=fixture-code&state='+state);await call('/api/me');
    const base={v:1,sub:'123456789001',guildId:'55555555555',channelId:'66666666666',exp:Date.now()+300000};
    for(const [aud,nonce] of [['jev-2048','ab'.repeat(16)],['jev-slide-score','cd'.repeat(16)]])
      assert.equal((await call('/api/context','POST',{launchToken:await signToken(f.env.APP_SIGNING_KEY,{...base,aud,nonce})})).status,200,aud);
    const foreign=await signToken(f.env.APP_SIGNING_KEY,{...base,aud:'jev-other',nonce:'ef'.repeat(16)});
    assert.equal((await call('/api/context','POST',{launchToken:foreign})).status,403);
  } finally {f.DB.close();}
});
test('the /2048 command keeps working and /slide-score is accepted; launch links use the new host',async()=>{
  assert.deepEqual(COMMAND_NAMES,['2048','slide-score']);
  const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const publicKey=hex(new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey)));
  const f=await fixture({...hosts,DISCORD_PUBLIC_KEY:publicKey,DISCORD_ALLOWED_CHANNELS:'55555555555:66666666666'});
  async function signed(data,origin=NEW) {
    const text=JSON.stringify(data),timestamp=String(Math.floor(Date.now()/1000));
    const signature=hex(new Uint8Array(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+text))));
    const response=await handleApi(new Request(origin+'/api/discord/interactions',{method:'POST',
      headers:{'content-type':'application/json','x-signature-timestamp':timestamp,'x-signature-ed25519':signature},body:text}),f.env);
    return {status:response.status,body:await response.json()};
  }
  try {
    const interaction=(id,name)=>({id,type:2,data:{name},guild_id:'55555555555',channel_id:'66666666666',channel:{type:0},member:{user:{id:'123456789001'}}});
    for(const [id,name,origin] of [['111111111111','2048',OLD],['222222222222','slide-score',NEW]]){
      const r=await signed(interaction(id,name),origin);assert.equal(r.status,200,name);
      const button=r.body.data.components[0].components[0];
      assert.ok(button.url.startsWith(NEW+'/#launch='),button.url);assert.match(button.label,/Slide Score vs Jev/);
    }
    assert.match((await signed(interaction('333333333333','tic-tac-toe'))).body.data.content,/Use \/2048/);
  } finally {f.DB.close();}
});
test('an audit bundle exported before the rename still passes scripts/verify.js',async()=>{
  const bundle=fileURLToPath(new URL('../examples/baseline-smoke/0001-0-heuristic/audit.json',import.meta.url));
  assert.equal(JSON.parse(await readFile(bundle,'utf8')).manifest.game,'2048','fixture predates the rename');
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/verify.js',import.meta.url)),bundle,
    'c506abe2d94d0b995ac55344338dba8aa266a0e3dca4d13391bb252d57a12f30']);
  const report=JSON.parse(stdout);assert.equal(report.ok,true);assert.equal(report.seedVerified,true);assert.equal(report.complete,true);
});
