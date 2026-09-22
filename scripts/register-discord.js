/** Register only this command; never bulk-overwrite unrelated Discord commands. */
const id = process.env.DISCORD_CLIENT_ID, secret = process.env.DISCORD_CLIENT_SECRET;
if (!id || !secret) { console.error('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env.'); process.exit(2); }
try {
  const auth = await fetch('https://discord.com/api/v10/oauth2/token', {method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64')},
    body: new URLSearchParams({grant_type: 'client_credentials', scope: 'applications.commands.update'}), signal: AbortSignal.timeout(10000)});
  if (!auth.ok) throw new Error(`Discord client authorization failed: HTTP ${auth.status}`);
  const token = (await auth.json()).access_token;
  const guild = process.env.DISCORD_TEST_GUILD_ID;
  const endpoint = `https://discord.com/api/v10/applications/${id}${guild ? `/guilds/${guild}` : ''}/commands`;
  const command = {name: '2048', type: 1, description: 'Play 2048 on your own board against JEV',
    ...(guild ? {} : {integration_types: [0], contexts: [0]})};
  const response = await fetch(endpoint, {method: 'POST', headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify(command), signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`Command registration failed: HTTP ${response.status}`);
  const result = await response.json(); console.log(JSON.stringify({commandId: result.id, name: result.name, guild: guild || 'global'}, null, 2));
} catch (error) { console.error(error.message); process.exit(1); }
