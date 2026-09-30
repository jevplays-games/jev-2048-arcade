# Notices

2048's conventional rules and name are used as the subject of a newly written two-board implementation. The original 2048 project by Gabriele Cirulli was consulted for rule semantics; its JavaScript and visual assets were not copied into this project.

JEV, TypeSafe, Discord, Node.js and Cloudflare are names of their respective products/projects. This package is an independent integration, not an endorsement or official release from any of those providers.

The application has no bundled third-party npm runtime dependencies. Optional Wrangler, Python Playwright, Chromium and PyArrow have their own licenses and installation requirements and are not included in the archive.

All example provider answers are explicitly synthetic fixtures unless a manifest states that an actual live-provider run was executed. The bundled baseline smoke runs contain no live model responses or real user identities.

Inter is bundled as a variable web font under the SIL Open Font License 1.1, Copyright (c) 2016 The Inter Project Authors. It is vendored at `public/brand/inter-var.woff2`; the full license text ships at `public/brand/OFL.txt`.

`@discord/embedded-app-sdk` 2.5.0 (MIT License, Copyright (c) Discord Inc.) is vendored as a single browser bundle at `public/vendor/discord-embedded-app-sdk.js`. It is loaded only when Discord launches the game as an Activity (see `docs/ACTIVITY.md`); it is not a package dependency.
