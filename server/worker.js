import {handleApi, HEADERS} from './app.js';
import {documentHeaders} from './activity.js';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, {...env, DEV_LOCAL: 'false'});
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(documentHeaders(url, HEADERS))) response.headers.set(key, value);
    return response;
  }
};
