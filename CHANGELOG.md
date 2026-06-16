# Changelog

## 0.1.0 (2026-06-16)


### Added

* **activity:** add live agentic wiki-maintainer Activity view with streaming transcripts ([27653a0](https://github.com/alaaeddine-ahriz/meOS/commit/27653a0dc95407396d314b207af9de4ee9884ef6))
* add multi-LLM provider support and image extraction ([c33b00a](https://github.com/alaaeddine-ahriz/meOS/commit/c33b00a02b90ee56f42afcb7e9b4993a475f5641))
* **api:** add @meos/contracts package, error envelope, and OpenAPI ([a491b27](https://github.com/alaaeddine-ahriz/meOS/commit/a491b27910a4c86aaee26684fd7bc47ffa8997f1))
* **api:** harden HTTP contracts with per-route schemas, typed client, and contract tests ([c7ee036](https://github.com/alaaeddine-ahriz/meOS/commit/c7ee036d66fa89da76057c591c67cad70e780009))
* **api:** validate routes against contracts and type the web client ([b4c5b4c](https://github.com/alaaeddine-ahriz/meOS/commit/b4c5b4c72f0a784d40364ade8b326d73ac28ca24))
* **chat:** add agentic graph exploration and wiki side panel ([f729b52](https://github.com/alaaeddine-ahriz/meOS/commit/f729b529a02570ab309a405848b3c00379a82067))
* complete privacy + governance — PII, audit trail, reversibility (item 13) ([c44604f](https://github.com/alaaeddine-ahriz/meOS/commit/c44604fdfeb2198a69dd5c3e26ff46b1f2072093))
* confidence-scored entity resolution during merge ([#17](https://github.com/alaaeddine-ahriz/meOS/issues/17)) ([b2a04ed](https://github.com/alaaeddine-ahriz/meOS/commit/b2a04ed74b7d7eeee42b22cb5366e3424cd90a29))
* **conflicts:** add auto mode for linked pages and contradictions ([25ac937](https://github.com/alaaeddine-ahriz/meOS/commit/25ac93750ff2afb381585a402d88e3c092a07847))
* connector materialization layer ([#19](https://github.com/alaaeddine-ahriz/meOS/issues/19)) ([0864d9a](https://github.com/alaaeddine-ahriz/meOS/commit/0864d9a56f8c8bd500138db8b1decc4cb13d760d))
* connector materialization layer ([#19](https://github.com/alaaeddine-ahriz/meOS/issues/19)) ([7e21492](https://github.com/alaaeddine-ahriz/meOS/commit/7e21492fbd920097f110c73aef57826a9331f2fa))
* **connectors:** add Google Contacts/Calendar/Gmail sync with OAuth ([4a3e85b](https://github.com/alaaeddine-ahriz/meOS/commit/4a3e85bb2c61e5f0690fd1fe9e942e9e0bf0181f))
* **connectors:** add Google Contacts/Calendar/Gmail sync with OAuth ([b6a2af2](https://github.com/alaaeddine-ahriz/meOS/commit/b6a2af2fe0704c99cc2133feb22c64dd67f3a9f6))
* **connectors:** add Google Tasks read/write connector ([d713bee](https://github.com/alaaeddine-ahriz/meOS/commit/d713beef54b3bf5256770bfc7063bda7a1af23ba))
* **connectors:** resumable Gmail backfill, multi-calendar sync, and coverage UI ([245cfba](https://github.com/alaaeddine-ahriz/meOS/commit/245cfba67a778d101ef164f9039b87adcd0f5570)), closes [#68](https://github.com/alaaeddine-ahriz/meOS/issues/68)
* contradiction resolution — propose + apply (item 11) ([05c02b4](https://github.com/alaaeddine-ahriz/meOS/commit/05c02b48ee917cf606466f317c4bddb59a855f78))
* **core:** hybrid retrieval over compiled knowledge + schema, provenance, self-healing ([86cdb7a](https://github.com/alaaeddine-ahriz/meOS/commit/86cdb7aa19f036dfda962e1b7f0337df824ecf16))
* **core:** operational memory lifecycle + tiers (intelligence layer) ([7e7a82b](https://github.com/alaaeddine-ahriz/meOS/commit/7e7a82bbb2195020a603959e852d6da2dded907b))
* **core:** query planner — intent classification routes retrieval + prompt ([724a36e](https://github.com/alaaeddine-ahriz/meOS/commit/724a36ea388ce25899545ffd98ef2cdc793eda0e))
* **core:** schema contract, rich typed claims, provenance + privacy at ingest ([97217eb](https://github.com/alaaeddine-ahriz/meOS/commit/97217eb9eb88aa582068239d2e409f4a901274c2))
* **core:** typed-graph lifecycle + graph-aware retrieval ([33ad286](https://github.com/alaaeddine-ahriz/meOS/commit/33ad2865d26ba3d9708b83e8587a90d6b4d98b39))
* **core:** wiki quality scoring + lint + self-healing (item 10) ([d8f4210](https://github.com/alaaeddine-ahriz/meOS/commit/d8f42101786363672512bad25647e87401733ab4))
* coverage gates and maintainable test strategy ([#21](https://github.com/alaaeddine-ahriz/meOS/issues/21)) ([19bdb4c](https://github.com/alaaeddine-ahriz/meOS/commit/19bdb4c93f3673d747660ce81eacccf6a0f6c27f))
* coverage gates and maintainable test strategy ([#21](https://github.com/alaaeddine-ahriz/meOS/issues/21)) ([c32baa6](https://github.com/alaaeddine-ahriz/meOS/commit/c32baa6c31d7a578239035c5466e594a274dcdad))
* **desktop:** package self-contained runtime and add CI build ([719db75](https://github.com/alaaeddine-ahriz/meOS/commit/719db7591a75247e2d7490ec4f5b5dae918da15e))
* document and modularize background workers with health surface ([#12](https://github.com/alaaeddine-ahriz/meOS/issues/12)) ([2bcbe27](https://github.com/alaaeddine-ahriz/meOS/commit/2bcbe276e94e2ba36ae783259093d07d2c52e299))
* document and modularize background workers with health surface ([#12](https://github.com/alaaeddine-ahriz/meOS/issues/12)) ([eaddc54](https://github.com/alaaeddine-ahriz/meOS/commit/eaddc540a63ca73fff8896c520eba9b9d9612445))
* durable, resumable, transactional ingestion pipeline ([#13](https://github.com/alaaeddine-ahriz/meOS/issues/13)) ([b567aab](https://github.com/alaaeddine-ahriz/meOS/commit/b567aab503347ebc82f02e956fa89794ca0e9f3a))
* durable, resumable, transactional ingestion pipeline ([#13](https://github.com/alaaeddine-ahriz/meOS/issues/13)) ([f8d0f88](https://github.com/alaaeddine-ahriz/meOS/commit/f8d0f88c9d5ba1f2c36c94eddbf91f1da0d157d5))
* **entity-resolution:** implement user dismissal of duplicate proposals ([667350b](https://github.com/alaaeddine-ahriz/meOS/commit/667350b5aa53289dade4658ea3706914add69c1a))
* event-driven automation bus (hooks) ([18e8f49](https://github.com/alaaeddine-ahriz/meOS/commit/18e8f496b1093a8202f89f19fa147bc18d6224ff))
* first-class connector framework / SDK ([#5](https://github.com/alaaeddine-ahriz/meOS/issues/5)) ([3edb4b4](https://github.com/alaaeddine-ahriz/meOS/commit/3edb4b493493d3745495508baabccf6784670969))
* first-class connector framework / SDK ([#5](https://github.com/alaaeddine-ahriz/meOS/issues/5)) ([db58530](https://github.com/alaaeddine-ahriz/meOS/commit/db5853024e654245ae86dee9a75228d47c7aea2c))
* formalize API contracts, error model, and typed client ([#23](https://github.com/alaaeddine-ahriz/meOS/issues/23)) ([04627f5](https://github.com/alaaeddine-ahriz/meOS/commit/04627f59a2ccaffc3912a7c6f36ba3d37e68f1ad))
* formalize source permissions and surface visibility ([#11](https://github.com/alaaeddine-ahriz/meOS/issues/11)) ([194cc36](https://github.com/alaaeddine-ahriz/meOS/commit/194cc36c2ada732bb4f01fae1c40b5d529bd85c4))
* **ingest:** add spreadsheet, presentation, email, html/rtf/odt parsers ([73b6bd9](https://github.com/alaaeddine-ahriz/meOS/commit/73b6bd95f161f0fdd3170883f30e02e7c3193d58))
* **ingest:** file-centric feed + content-hash change detection ([966ecab](https://github.com/alaaeddine-ahriz/meOS/commit/966ecab58c8ec13de20f9e8d7ff7670c30e089ac))
* ingestion observability, budgets, and backpressure ([#18](https://github.com/alaaeddine-ahriz/meOS/issues/18)) ([23a7440](https://github.com/alaaeddine-ahriz/meOS/commit/23a7440d170bd8df8b5411b4d3f6713adc5b028a))
* ingestion observability, budgets, and backpressure ([#18](https://github.com/alaaeddine-ahriz/meOS/issues/18)) ([b706790](https://github.com/alaaeddine-ahriz/meOS/commit/b70679017ae881986c77288932658e1bfa6185e9))
* knowledge graph view and Git sync of the data dir ([71966c8](https://github.com/alaaeddine-ahriz/meOS/commit/71966c81c405286247e6041efc065fdc3f430902))
* light up wiki retrieval (backfill) + human-gated entity dedup ([9ad1bbc](https://github.com/alaaeddine-ahriz/meOS/commit/9ad1bbc35b826fd8c37aca5fffe6830c681da38f))
* **llm:** add openai-compatible local provider with model discovery ([d52d620](https://github.com/alaaeddine-ahriz/meOS/commit/d52d6202b6918cedd636fbb4be4a123ae6e90bc6))
* **llm:** normalize provider errors into clear, actionable messages ([8bc5a45](https://github.com/alaaeddine-ahriz/meOS/commit/8bc5a45d78743862ec383421525e9b6e497e6c37))
* map-reduce large-document extraction ([#15](https://github.com/alaaeddine-ahriz/meOS/issues/15)) ([5527f8f](https://github.com/alaaeddine-ahriz/meOS/commit/5527f8f9a1b25f1c4a97e93de9383ccdf3ead058))
* map-reduce large-document extraction ([#15](https://github.com/alaaeddine-ahriz/meOS/issues/15)) ([0c4c821](https://github.com/alaaeddine-ahriz/meOS/commit/0c4c82128963b4cb3aa2727d910373222801ea9d))
* marketing landing page + GitHub Pages deploy ([#65](https://github.com/alaaeddine-ahriz/meOS/issues/65)) ([7fe805d](https://github.com/alaaeddine-ahriz/meOS/commit/7fe805d356de180748bdefa2e71fb0f4b3175abf))
* meeting notes as auto-linked trusted sources ([#26](https://github.com/alaaeddine-ahriz/meOS/issues/26)) ([97bc59e](https://github.com/alaaeddine-ahriz/meOS/commit/97bc59ee5fd77c9bc2a99985a03c9a595a5cedc1))
* meeting notes as auto-linked trusted sources ([#26](https://github.com/alaaeddine-ahriz/meOS/issues/26)) ([0f55626](https://github.com/alaaeddine-ahriz/meOS/commit/0f55626cfa72225f78d85f2ca89fd3da60b73ead))
* **notes:** unify notes & meetings in one editor with front matter and @-refs ([#63](https://github.com/alaaeddine-ahriz/meOS/issues/63)) ([5d78156](https://github.com/alaaeddine-ahriz/meOS/commit/5d7815630a68fcc07ded6c5a3d0646ab0a6bcc3e))
* output modes — briefs, timelines, dependency graphs, reports (item 14) ([f6e0e1a](https://github.com/alaaeddine-ahriz/meOS/commit/f6e0e1a8d7f1462e22d12619d60caa069ad83adc))
* **playwright:** add navigation links and command palette to graph page ([bf9c3d8](https://github.com/alaaeddine-ahriz/meOS/commit/bf9c3d863366b19650b50804e14a30645ff138c2))
* **privacy:** enforce source visibility across surfaces ([05dcbcb](https://github.com/alaaeddine-ahriz/meOS/commit/05dcbcb5db0e3a99353d912718faed44dd9271a7))
* **privacy:** migration + source-level visibility flags ([da939b6](https://github.com/alaaeddine-ahriz/meOS/commit/da939b6c3535afd9fff10d8be82ada6824d7caa5))
* **privacy:** settings copy + visibility tests ([108b492](https://github.com/alaaeddine-ahriz/meOS/commit/108b492bc4717a7fcb97878d0a2232e2e727222e))
* **profile:** implement profile & work context system with slash commands and inline diffs ([ddda20d](https://github.com/alaaeddine-ahriz/meOS/commit/ddda20d1233b0d025d9b84d9a770baea1e8f89ad))
* retrieval and ingestion benchmarks ([#7](https://github.com/alaaeddine-ahriz/meOS/issues/7)) ([4bf5d04](https://github.com/alaaeddine-ahriz/meOS/commit/4bf5d04813c4b607edd55d79bd35ffc7b1e26773))
* session crystallization — conversations become first-class sources (item 12) ([05ef33d](https://github.com/alaaeddine-ahriz/meOS/commit/05ef33db83b2892373b94b77a6b0f78c042e9e98))
* **settings:** make model dropdown dynamic and searchable ([cba6df6](https://github.com/alaaeddine-ahriz/meOS/commit/cba6df6a337a23ad5c610832ae4cfb39cb31721d))
* source revisions, deletions, and stale facts ([#16](https://github.com/alaaeddine-ahriz/meOS/issues/16)) ([068323b](https://github.com/alaaeddine-ahriz/meOS/commit/068323b7804566404f5c9f3f542ec897e72062ab))
* source revisions, deletions, and stale facts ([#16](https://github.com/alaaeddine-ahriz/meOS/issues/16)) ([3c00cc4](https://github.com/alaaeddine-ahriz/meOS/commit/3c00cc4abc92d1158155f2e5271a5cfcc55807c7))
* structure-aware parsing and chunk metadata ([#14](https://github.com/alaaeddine-ahriz/meOS/issues/14)) ([fe8f963](https://github.com/alaaeddine-ahriz/meOS/commit/fe8f9636132352513b9fe3e6a8e5af33ee489a72))
* structure-aware parsing and chunk metadata ([#14](https://github.com/alaaeddine-ahriz/meOS/issues/14)) ([1fc8d2e](https://github.com/alaaeddine-ahriz/meOS/commit/1fc8d2e763e3c29c0fd89577121ba605a99e1361))
* **temporal:** make fact dates a first-class answer-time pertinence signal ([00900f5](https://github.com/alaaeddine-ahriz/meOS/commit/00900f59f310b7c669f532e00f67ec2abfac1474))
* **theme:** add shadcn palette with base font configuration ([14ff023](https://github.com/alaaeddine-ahriz/meOS/commit/14ff02367331c189a18952240e8cf7131dfd117a))
* **vault:** add Obsidian-style note editor with @ mentions ([d8c05e6](https://github.com/alaaeddine-ahriz/meOS/commit/d8c05e69a8df54cf5f470eb77f845fec54ba573f))
* **web:** contradiction resolution view ([b6bec5c](https://github.com/alaaeddine-ahriz/meOS/commit/b6bec5c3731c446751da4d024018e584a0cf09f3))
* **web:** Notion/Claude-style UI refresh with appearance prefs, shared layout, and ai-elements chat ([44f077f](https://github.com/alaaeddine-ahriz/meOS/commit/44f077f965e101de8d12129b4c0dfb4cc97321f5))
* **web:** reading-width & motion settings, focused wiki connections graph ([da9b437](https://github.com/alaaeddine-ahriz/meOS/commit/da9b437f34b9743febfb628fd2e4edeb4dddc6c5))
* **web:** surface duplicate entities in the Conflicts view ([12745e9](https://github.com/alaaeddine-ahriz/meOS/commit/12745e924d31765c4b201d755611fe725fc29800))
* **wiki-ui:** surface each fact's date and staleness on the wiki page ([63d3482](https://github.com/alaaeddine-ahriz/meOS/commit/63d348252a01a4d6e0f9e35e56bd319b77a38c8a))
* **wiki:** add git-backed diffs with per-document commits and history browsing ([ef91c9f](https://github.com/alaaeddine-ahriz/meOS/commit/ef91c9f8126336ee197af10bcc839f404dfae3d0))
* **wiki:** browse connector-linked entities (Linked tab) ([#66](https://github.com/alaaeddine-ahriz/meOS/issues/66)) ([1d0f6dd](https://github.com/alaaeddine-ahriz/meOS/commit/1d0f6dd53ced2963941d287ef6158112071f31db))
* **wiki:** external services as reference chips, not pages ([#62](https://github.com/alaaeddine-ahriz/meOS/issues/62)) ([1d00f2e](https://github.com/alaaeddine-ahriz/meOS/commit/1d00f2ea7e5ef294729161232bd03fa74c9ca929))
* **wiki:** synthesise smooth prose with inline backlinks ([6f1bdec](https://github.com/alaaeddine-ahriz/meOS/commit/6f1bdeca07738dc2d7b4f31c27be7e6e9817c8f9))


### Fixed

* **db:** repair inbox_items status CHECK stuck on pre-extract-failed set ([#60](https://github.com/alaaeddine-ahriz/meOS/issues/60)) ([fdf7bf9](https://github.com/alaaeddine-ahriz/meOS/commit/fdf7bf916b8bd25cb80eccda39800efc45cfd095))
* **desktop:** invoke npm via npm.cmd on Windows in bundle script ([fea9301](https://github.com/alaaeddine-ahriz/meOS/commit/fea9301bc04548356fbbd926f445cc03dba1d762))
* **editor:** track the slash-command menu and load table command types ([6f602c0](https://github.com/alaaeddine-ahriz/meOS/commit/6f602c050215b330cf00a35b54cf70e396368886))
* **entity-resolution:** re-fetch duplicate proposals after a merge ([921cbfd](https://github.com/alaaeddine-ahriz/meOS/commit/921cbfdcfe67d0e1d81ffce8f7b0fbd521e359cb))
* **entity-resolution:** require name overlap for duplicate proposals ([0d5fc16](https://github.com/alaaeddine-ahriz/meOS/commit/0d5fc16c836cb8933e110b92982e99dc1501cc5a))
* **graph:** limit node speed to prevent simulation divergence ([c387487](https://github.com/alaaeddine-ahriz/meOS/commit/c387487a95eedf204f4ece081d15ad2b33eb8556))
* **lint:** remove unnecessary type assertion in settings route ([d555709](https://github.com/alaaeddine-ahriz/meOS/commit/d555709f1954c2d9b4a8bb15761c2790bca3d9ca))
* resolve @meos/contracts in dev and desktop bundling ([c58a58f](https://github.com/alaaeddine-ahriz/meOS/commit/c58a58f7a5b95bb7e0e0e39a99371d67504827cb))
* resolve @meos/contracts in dev and desktop bundling ([f3e4b9b](https://github.com/alaaeddine-ahriz/meOS/commit/f3e4b9b8a3a3ce37bce0d542e611112c58b2b449))
* **web:** render chat references as chips, not raw markup ([e48390f](https://github.com/alaaeddine-ahriz/meOS/commit/e48390f1755dd6f8be0ab1f195f23d9b4e5040d7))
* **wiki:** don't create pages for factless connector entities ([#64](https://github.com/alaaeddine-ahriz/meOS/issues/64)) ([536711b](https://github.com/alaaeddine-ahriz/meOS/commit/536711b330051df2dabd7f697d8188d39d01a51e))
* **wiki:** drop relationships from synthesised body (rendered separately) ([156856a](https://github.com/alaaeddine-ahriz/meOS/commit/156856ac4017c5a0b46e2cb80288224da22b6841))
* **wiki:** never ship an empty page — deterministic body fallback ([78c401a](https://github.com/alaaeddine-ahriz/meOS/commit/78c401a690f95dc72d784be283c6fa7b437fabd5))


### Changed

* add CONTRIBUTING, ADRs, focused docs and issue templates ([#9](https://github.com/alaaeddine-ahriz/meOS/issues/9)) ([67e4ab2](https://github.com/alaaeddine-ahriz/meOS/commit/67e4ab2b5ec366699e9d32f8920bbe622e47a307))
* add CONTRIBUTING, ADRs, focused docs and issue templates ([#9](https://github.com/alaaeddine-ahriz/meOS/issues/9)) ([4843047](https://github.com/alaaeddine-ahriz/meOS/commit/4843047049cb3e6f0b7cb5f1e8546d79ffbe2648))
* **core:** centralize duplicated logic from the session's diff (/simplify) ([b5911a4](https://github.com/alaaeddine-ahriz/meOS/commit/b5911a4c5fb96d08a31b9af2feb2d68f0befb37f))
* drop orphaned Unreleased placeholder from changelog ([1c53c4e](https://github.com/alaaeddine-ahriz/meOS/commit/1c53c4e39729b9ab0084b2e7bd1a02b29a703b84))
* make the repo map and architecture explicit ([#4](https://github.com/alaaeddine-ahriz/meOS/issues/4)) ([891395d](https://github.com/alaaeddine-ahriz/meOS/commit/891395d30aa7bece8c0e0280290f8aac3ed2fa1e))
* make the repo map and architecture explicit ([#4](https://github.com/alaaeddine-ahriz/meOS/issues/4)) ([84443c6](https://github.com/alaaeddine-ahriz/meOS/commit/84443c6b1d55bc33732fcab33ec6de06c4254e94))
* **readme:** document dev + self-contained/CI desktop builds ([d6e6f71](https://github.com/alaaeddine-ahriz/meOS/commit/d6e6f713e5a32e105b83707633c798dc61b0befc))
* **readme:** document Google connectors feature ([e57dfd7](https://github.com/alaaeddine-ahriz/meOS/commit/e57dfd73bde641808294bf072f897ceff4768ad5))
* **readme:** match the consolidated nav and content-hash ingestion ([7f711e5](https://github.com/alaaeddine-ahriz/meOS/commit/7f711e50379d7157745b6d0145c7d5da92fc8809))
* release first version as 0.1.0 ([6ee255f](https://github.com/alaaeddine-ahriz/meOS/commit/6ee255f0eba688d1d09446df79a9ee806634803b))
* simplify graph/chat cleanups from review ([f7dd787](https://github.com/alaaeddine-ahriz/meOS/commit/f7dd78743661c71fe51297c441af3417dcebf67c))
* simplify graph/chat cleanups from review ([444cff3](https://github.com/alaaeddine-ahriz/meOS/commit/444cff35ee4a87657dd42b91beb12706c9d1396c))
* **ui:** adopt sidebar settings pane and remove quick-capture ([d595947](https://github.com/alaaeddine-ahriz/meOS/commit/d59594784d123ae9b5b7a0781fa2f76b58d89d46))
* unify LLM providers on the Vercel AI SDK; agentic wiki writer ([b33c223](https://github.com/alaaeddine-ahriz/meOS/commit/b33c22306a996484e8edfb492e7d6d4b0b6d6020))
* **web:** consolidate 8 nav tabs into 4 with an Activity hub ([9bd827d](https://github.com/alaaeddine-ahriz/meOS/commit/9bd827d3ecd5c7ccb7ba5ec5c143364612dc4cc5))
* **web:** dedupe count badge, drop redundant feed timestamp, fetch review count once ([400df0c](https://github.com/alaaeddine-ahriz/meOS/commit/400df0c80c54d25a64756ed2ee212f4bf10d6f6c))
* **web:** organize settings into tabbed panels ([e9f9849](https://github.com/alaaeddine-ahriz/meOS/commit/e9f98490195b2581590991b5a0466340af963e77))
* **web:** simplify Activity hub to Feed · Review · Digest ([5586116](https://github.com/alaaeddine-ahriz/meOS/commit/5586116d9ed8d9616fdf04da510ba4361ab9c0a2))
* **web:** simplify tiptap simple-editor component ([575b96a](https://github.com/alaaeddine-ahriz/meOS/commit/575b96a9c022f2bf0fed38bb24ead0237322474f))
* **web:** single inbox poll, shared timestamp util, memoized feed ([277d0f9](https://github.com/alaaeddine-ahriz/meOS/commit/277d0f9ec4ac36054a10fe0b3dfba5dbc8ffa84a))

## Changelog

All notable changes to MeOS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

See [docs/releasing.md](docs/releasing.md) for the release policy, tagging
convention, and the per-release checklist. From the 0.1.0 release onward this
file is generated from Conventional Commits by
[Release Please](https://github.com/googleapis/release-please-action).
