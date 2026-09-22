import {randomHex} from '../public/core/crypto.js';
for (const key of ['APP_SIGNING_KEY', 'SEED_ENCRYPTION_KEY', 'ADMIN_API_KEY']) console.log(`${key}=${randomHex()}`);
