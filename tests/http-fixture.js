import {readFile} from 'node:fs/promises';
import {createSqlite} from '../server/sqlite.js';
import {handleApi} from '../server/app.js';
const migration=await readFile(new URL('../migrations/001_initial.sql',import.meta.url),'utf8');
export async function fixture(extra={}) {
  const DB=createSqlite();DB.exec(migration);
  const env={DB,PUBLIC_ORIGIN:'http://localhost',DEV_LOCAL:'true',APP_SIGNING_KEY:'11'.repeat(32),
    SEED_ENCRYPTION_KEY:'22'.repeat(32),TEST_MOVE_LIMIT:'3',...extra};
  let cookie='',csrf='';
  async function call(path,method='GET',data,overrides={}) {
    const headers={'cookie':cookie,'origin':env.PUBLIC_ORIGIN,'x-csrf-token':csrf,
      'content-type':'application/json',...overrides};
    const response=await handleApi(new Request(env.PUBLIC_ORIGIN+path,{method,headers,
      ...(data===undefined?{}:{body:JSON.stringify(data)})}),env);
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const text=await response.text();const body=text?JSON.parse(text):{};if(body.csrf)csrf=body.csrf;
    return {status:response.status,body,headers:response.headers};
  }
  await call('/api/me');return {DB,env,call,context:()=>({cookie,csrf})};
}
