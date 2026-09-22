# Sources, provenance and design choices

## User-provided requirements

The supplied “JEV Single-Page Game — Architecture & Implementation Planning Prompt” requested vanilla browser code, a minimal trusted backend, explicit legal candidates, structured JEV decisions, Discord identity plus verified channel/server context, verified leaderboards, replay, observability and benchmarking. The follow-up requested separate 2048 boards and exhaustive analytics. The conversation's 2048 architecture established synchronized active boards, matched randomness, a 2,048-move competitive cap and a score-based duel.

This package implements those concepts rather than copying an existing game's source. The observability expansion includes detailed event/metric dictionaries, evidence exports, normalized tables, offline checking and seed-paired experiments. “Exhaustive” is bounded to the implemented game/decision pipeline; unsupported infrastructure, biological or billing measurements are explicitly not invented.

## Public technical documentation consulted

Consulted for the implementation contract on 2026-09-22. Recheck these when deploying or changing a pinned version; documentation can change.

- TypeSafe API: https://docs.typesafe.ai/api
- TypeSafe Score primitive: https://docs.typesafe.ai/primitives/score
- TypeSafe models: https://docs.typesafe.ai/models
- TypeSafe confidence semantics: https://docs.typesafe.ai/confidence
- TypeSafe model arithmetic/counting limitations: https://docs.typesafe.ai/model-jaggedness/jev-1.13
- Discord OAuth2: https://docs.discord.com/developers/topics/oauth2
- Discord interaction overview: https://docs.discord.com/developers/interactions/overview
- Discord application commands: https://docs.discord.com/developers/interactions/application-commands
- Cloudflare Static Assets: https://developers.cloudflare.com/workers/static-assets/
- D1 database/batch interface: https://developers.cloudflare.com/d1/worker-api/d1-database/
- Workers Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Node SQLite: https://nodejs.org/api/sqlite.html
- Original 2048 game manager, referenced for conventional gameplay semantics: https://github.com/gabrielecirulli/2048/blob/master/js/game_manager.js

## Implementation decisions, not external facts

The competitive move cap, paired priority-permutation spawn coupling, profile weights, risk penalty, lookahead ceilings, lease/session/context lifetimes, quotas and local fallback ordering are explicit application choices. They are not claims about conventional multiplayer 2048, an optimal JEV strategy or provider recommendations.

The delivered application uses a native Node/SQLite entry point in addition to the proposed Worker/D1 adapter, allowing immediate execution without cloud setup. Search budgets count admitted states including leaves; root moves receive equal budget shares. This is more precisely bounded than an internal-node-only counter but does not guarantee identical work across every subtree.

No live external service or cloud deployment is represented by the fixtures. See VALIDATION.md for the measured environment and remaining verification boundaries.
