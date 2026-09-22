#!/usr/bin/env node
/** Local SQLite maintenance; defaults to dry run. Stop the server and back up first. */
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
const args=process.argv.slice(2), get=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const file=resolve(get('--db', '.data/arcade.sqlite')), user=get('--delete-user',null), confirm=get('--confirm',null);
const execute=args.includes('--apply'), days=Number(get('--guest-days','30'));
if(!Number.isInteger(days)||days<1||days>3650)throw Error('--guest-days must be 1..3650.');
if(user && (!/^\d{5,24}$/.test(user) || (execute && confirm!==user)))throw Error('Deletion requires --delete-user ID --apply --confirm ID.');
const db=new DatabaseSync(file,{readOnly:!execute}); db.exec('PRAGMA foreign_keys=ON;');
const now=Date.now(), cutoff=now-days*86400000;
const matches=user?db.prepare('SELECT id FROM matches WHERE user_id=?').all(user):
  db.prepare("SELECT id FROM matches WHERE user_id IS NULL AND created_at<? AND (status!='active' OR expires_at<?)").all(cutoff,now);
const report={database:file,dryRun:!execute,deleteUser:user,guestRetentionDays:days,matches:matches.length,
  expiredProofs:db.prepare('SELECT COUNT(*) AS n FROM proofs WHERE expires_at<?').get(now).n,
  expiredSessions:db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at<?').get(now).n};
if(execute){
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const {id} of matches){
      for(const table of ['results','round_requests','events','telemetry'])db.prepare(`DELETE FROM ${table} WHERE match_id=?`).run(id);
      db.prepare('DELETE FROM matches WHERE id=?').run(id);
    }
    db.prepare('DELETE FROM proofs WHERE expires_at<?').run(now);
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
    if(user){
      db.prepare('DELETE FROM proofs WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)').run(user);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user);
      db.prepare('DELETE FROM users WHERE id=?').run(user);
    }
    // Quota keys have mixed window sizes. Do not guess an expiry from window_start.
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
console.log(JSON.stringify(report,null,2));db.close();
