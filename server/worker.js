import {handleApi, HEADERS} from './app.js';
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) return handleApi(request, {...env, DEV_LOCAL: 'false'});
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(HEADERS)) response.headers.set(key, value);
    return response;
  }
};
