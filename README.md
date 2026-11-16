# dsh-fact-memory

[English | 简体中文](README.zh-CN.md)

Cross-session fact memory for [DeepSeek Harness](https://github.com/deepseek-ai): one SQLite truth source, three tools, and a budgeted directory that rides along with every request.

> [!IMPORTANT]
> **A fact, not a document.** A memory here is a claim with a subject, a property, a value, an evidence level and a time. The user's own words outrank anything the model inferred; a value the model guessed never silently replaces one the user stated — it becomes a visible conflict instead.
>
> **Memory is history, not an instruction.** The directory tells the model *what the store contains*, never what to do. Every recalled fact carries its date, time-sensitive claims must be verified with live tools before acting, and no memory grants permission.
>
> **Remembering wrongly is worse than not remembering.** Automatic capture is off by default, credential-looking values are refused outright, personal data is stored but withheld from model context, and forgetting writes a tombstone that blocks the same claim from being written back later. The last two are defaults, not laws: with `refuseCredentials` off a credential is kept as a sensitive fact (still never model-visible), and only `sensitiveModelVisible` lets sensitive facts into the directory and search results.

## Why

Each session starts from zero. A preference the user stated last week, a port number agreed in an earlier task, a convention the project settled on — all of it disappears unless it is copied into every prompt.

The usual workarounds all fail in different ways: a giant persona prompt grows without limit and is impossible to maintain; a document knowledge base answers "what does the documentation say", not "what did the user tell me"; summarizing past sessions is lossy and only gets worse with length.

This plugin keeps a small, structured, inspectable store instead:

| Approach | Fails because |
| --- | --- |
| Persona prompt | Every request pays for every fact; editing means rewriting prose |
| Document KB | Facts are keyed by subject+property, not by document similarity |
| Session summaries | Lossy, unbounded, and the model cannot cite a specific claim |
| **This plugin** | Structured slots, budgeted recall, evidence and dates preserved |

## What it does

| Surface | Detail |
| --- | --- |
| Dynamic context `dsh-fact-memory:directory` | A budgeted list of current facts (subject · property: value), recomputed on every request, truncated with a "N more, use memory_search" footer |
| `agent/pre-step` notice | One short notice per session (first turn, plus turns that mention memory), telling the model the tools exist |
| `memory_search` | BM25 over Chinese/English text, an exact-identifier channel, an optional vector channel, fused with RRF, optionally reranked; returns dated, sourced hits and says which channels ran |
| `memory_write` | One durable fact; idempotent by content hash; single-valued slots replace or conflict by evidence level; an inferred or low-confidence value becomes a proposal instead of a row |
| `memory_forget` | By fact id or subject; logical delete plus a tombstone |
| Automatic extraction (`turn/end` → background queue → model → validation → fact or proposal) | Runs in the background after each turn so the conversation never waits; strictly FIFO within one session, parallel across sessions. That turn's new user text and the assistant's reply are sent: text only, no tools, no write access. The JSON answer is validated locally against a strict schema, and a candidate whose verbatim quote does not occur in the input is dropped. Below the confidence floor it becomes a proposal. Off by default. |
| `POST /api/fact-memory/{status,export,rebuild,import,conflicts,resolve,proposals,proposal-apply,proposal-reject,proposal-revise,proposal-prune,audit,review-seen,graph,index-vectors,calibrate,consolidate,extract,key,activity,sessions,queue,facts,fact,fact-update,fact-expire,fact-restore,extract-run,entity,wipe}` | JSONL exchange, index rebuild, conflict list and settlement, the proposal queue (one aggregated card can lose a row with `proposal-prune`), the health check (`{force:true}` runs it now, `{summary:true}` reads the ledger, `review-seen` marks the queue as read), the graph projection, the semantic index/calibration, one sweep of the near-duplicate review (`{force:true}` runs it now, `{summary:true}` reads the ledger), one-off extraction of a text, storing an API key in the host credential store, and a factory reset (confirm token required, backup written first) |
| Conversation surfaces | A turn-tail card (“this turn wrote N facts”, with pending and unsettled counts, and a View button), a right-pane “memory detail” drawer listing what that conversation wrote, and a small memory mark on the session row. Counts come from the store, so they survive a restart; a fact written by the tool during a turn is anchored to that conversation, and a turn with no extraction summary still gets its card from those anchored facts. Extraction is asynchronous, so the card keeps asking until that session's pass settles (wrote something, or confirmed it wrote nothing) — a slow model no longer looks like “no card ever”. |
| Sidebar page “Fact memory” | Six tabs: the fact library (search, status filters, detail with value history, edit and expire), the nebula graph (3D, switchable back to the one-hop tree), the proposal queue, unsettled conflicts, and the extraction queue (running / queued / waiting out the debounce / waiting out a retry / parked after repeated failures, with the due time). “Recently finished” keeps the last ten passes in the store (`extract_runs`, so they survive a restart) and each row says how many facts were written, how many need review, how long it took, and how long ago; a log that is still empty explains itself instead of showing a blank block. Opening one row shows the exact text that pass sent to the model, its message/chunk count and model name, and why candidates were refused (a prefilter skip says outright that no model was called); the text is capped at 20k chars — it is a diagnostic, not a second copy of the chat. Auto refresh is off by default — 5/10/15/30s or a manual refresh, and polling stops when you leave the tab. The library reads 100 rows at a time and offers Load more instead of a hard cap; edits, expiries and accepted proposals end in a dismissable toast that can undo them (expiry and edits go back through `fact-restore`); the search box focuses on `/`, clears on Esc and remembers the last five queries; the first paint is a skeleton, and an empty store shows one sentence you can copy; below 1180px the detail pane becomes a bottom sheet that closes on the backdrop; hovering a star names it and its fact count, and the graph frame follows a light theme; status pills carry a shape prefix, not color alone. Registered on `sidebar.panellist` + `main`, so it is a first-class destination, not a settings form. The sixth tab reviews the dream layer (see below). |
| Session header button | A “memory” button in `conversation.session.header.utilities` with a badge counting pending proposals plus open conflict groups; it opens the page. |
| Settings card | A summary that points at the page for real work (proposals are listed only on the page, never repeated in the card): fields for the everyday keys, plus a folded “Advanced” section at the bottom for the tuning knobs (budgets, timeouts, the time zone, backup rotation, the duplicate check), live counts, the one-hop graph preview, and the open conflicts with their date and evidence, so one can be settled without restating it in chat. Buttons: export, reindex, rebuild vectors (only when an embedding model is configured), find near-duplicates, run the health check, and "Clear everything" (wipes facts/entities/proposals/conflicts/indexes, keeps the settings and the extraction run log, backs up first, asks for a second click) |

Tool outcomes are a closed set: `ok`, `saved`, `pending`, `needs_selection`, `not_found`, `refused`, `conflict`, `unavailable`. An empty result means "the store has no record", never "the claim is false".

## How it works

**Storage.** One SQLite database through the built-in `node:sqlite` module — no native build, no sidecar service. WAL, foreign keys on, `synchronous=FULL`, nested transactions via savepoints. A generation counter bumps on every committed write, so the card can show that the store changed.

**Slots and claims.** A fact is `(entity, predicate, scope, qualifiers, value)` plus evidence. Its claim key is a SHA-256 over the normalized entity, predicate, qualifier set and value. A partial unique index allows only one *current* fact per single-valued slot; multi-valued slots accumulate.

**Evidence and replacement.** Evidence ranks `explicit_user` (the user's own words) > `confirmed_user` (what accepting a proposal writes) > `observed` (read out by the model) > `unverified`. A trusted new value supersedes the old row bi-temporally (`valid_to` set, `superseded_by` pointed forward). An untrusted contradiction keeps both rows, marks the new one `conflict`, opens a conflict group, and lets `memory_search` report `needs_selection` — the model is told it cannot treat either as settled. When the user later states the answer themselves, the slot settles: rivals are retired, the group closes, and only one current value remains. The settings card lists open conflicts with the date and evidence of each side, so a user can settle one directly without restating it in chat.

**Dedupe before writing.** The same statement arrives through three paths — the rule matcher, the model extractor and an explicit `memory_write` — worded slightly differently each time, and left alone the graph fills with near-identical nodes. Two gates run before a row is written: subject names are canonicalized first (case and separators folded, a trailing role word such as plugin/project/service dropped, so `DSH Fact Memory` and `dsh-fact-memory` are one subject, and so is the same name carrying a trailing role word), and a write whose claim key already exists is a duplicate. Otherwise an IDF-weighted cosine decides at 0.72, with at least 3 shared tokens required (cosine is jumpy on short text). The load-bearing rule is the **rare-token veto**: when two statements are lexically nearly identical but only one side carries a rare identifier (`7801` vs `7802`, `bge-m3` vs `bge-large`), they do not merge however high the cosine is — in Fellegi-Sunter terms a rare token present on one side only is strong evidence of non-match. The veto only looks at identifier-shaped ASCII tokens; a difference between two CJK bigrams is exactly what the cosine is for. Below 12 facts IDF means nothing, so near-duplicate matching is off and only exact duplicates are folded.

**Near-duplicate review.** The pre-write gate only sees the fact being written, so a library that already holds two ways of saying one thing stays split forever. A background sweep closes that gap. Candidates are the union of the lexical gate and embeddings (cosine at or above `consolidateCosineFloor`, 0.85 by default): the lexical leg keeps the identifier-difference cases the vector leg smooths over, and the vector leg catches the re-phrasings the lexical leg cannot see. Only pairs inside one subject and one scope are compared, and sensitive facts are excluded at the SQL layer — their text never reaches the model. The model answers one closed question (same / distinct / unsure) and is never shown fact ids or asked which row to keep; the keeper is decided by rules (evidence level, then the earlier observation, then id order), so the same pair always yields the same proposal. A distinct verdict is remembered per vector generation, so a pair costs one call, not one per sweep. A sweep spends at most `consolidateMaxPairs` calls and interleaves subjects, because one subject with a row per night would otherwise consume every call the run is allowed; the settings-card button forces a sweep with triple that budget. Nothing is applied automatically: same and unsure produce one `merge` proposal, and accepting it retires the loser as `superseded` while its sources move to the keeper.

**When it runs.** The sweep is built into the plugin: no cron job, no Windows Task Scheduler entry, no dsh scheduled task, and nothing anyone has to remember to press. A timer starts two minutes after the plugin loads — the vector sweep starts at 15 s, and rows without vectors yet would only tell the lexical leg what it already knows — and then looks at the clock once a minute, running a sweep when `consolidateIntervalMs` has elapsed since the last one. Two consequences are worth knowing before you rely on it: it only runs while DSH is running, and the clock lives in memory, so a restart resets it and a sweep runs about two minutes after each start rather than waiting out the remainder. Cost stays bounded by the rules above — at most `consolidateMaxPairs` calls per sweep, and each pair is judged once per vector generation, so a sweep over an unchanged library calls no model at all. With no usable model the candidates are parked as `deferred` and nothing is written; with no embedding provider only the lexical leg runs, which misses re-phrasings. To turn it off, `consolidateIntervalMs: 0` leaves the button and the route as the only triggers and `autoConsolidate: false` disables the feature outright; the settings-card button (or `POST /api/fact-memory/consolidate` with `{force:true}`) runs one sweep immediately with triple the budget.

**Retired, not erased.** When a trusted value replaces another, the old row is not deleted: it is marked `superseded`, points at its replacement with `superseded_by`, and its `valid_to` is stamped with the instant the replacement arrived. That bi-temporality is the whole point — "the port was 7801 until Tuesday" stays answerable, and an export still shows what the library believed last month. Nothing in the plugin deletes a fact except `memory_forget` and the explicit "Clear everything" — both are a person's request.

**Folded log lines.** A nightly backup, a daily self-check, a weekly sweep: the **facts they report** share one subject and one property and differ only by date (these are the contents of recurring facts — the plugin runs no nightly job of its own). One row per night buries everything else under a pipeline, so a write whose value matches the stored one apart from exactly one calendar date now updates that row in place — value, observation time, source list — and increments `folded_count`, keeping the last 20 prior values in `folded_from`. How many values the slot allows makes no difference: a slot open to many values still holds one row for one recurring line, because whether two statements are the same statement has nothing to do with how many the slot may keep. The guard is deliberately strict: the value must hold exactly one parsable date and at least four other characters, so `187`/`188`, `port 7801`/`port 7802` and `from 20260101 to 20260201` never fold into each other. Retrieval still prints the date and the fold count, so a folded row keeps its history.

**Newest first within a slot.** Rows that share a subject, property and qualifiers are one slot. Whatever their lexical score, the slot is rendered newest-observed first, anchored where its best-ranked member would have been, so a two-month-old duplicate never outranks the row that replaced it. Nothing is dropped: the old rows stay below it and still answer "what did it used to be".

**The health check.** Every six hours the plugin audits its own library for three shapes a write-time gate cannot see: a fact that only restates its own property ("failed with an error message"), a pipeline that folding could not catch because the date sits in the property name, and one subject spelled as two entities. Each class becomes **one aggregated proposal** — details listed inside it, capped at 50 per proposal (a longer list continues as a second batch, numbered n/m) — so a library with two hundred stale rows still asks for **one** decision, not two hundred. Accepting a proposal retires the self-referential rows, folds the pipeline into its newest row, or aliases the fragment entity into its canonical one; nothing changes until you accept. Folding here counts too: the survivor records how many runs it absorbed, so it reads "seen 7 times" the same way a write-time fold does. A card is also judged per row, not all-or-nothing: if a row was edited between the sweep and the click, that row is skipped (and reported as `skippedStale`) while the rest of the batch still applies — and if *nothing* lands, the card refuses instead of claiming success. One row inside a batch can also be struck out before accepting (`proposal-prune`), so a single false positive does not force you to reject the whole card. The page also shows a digest of what arrived since you last looked, so "38 pending" becomes "12 new since Tuesday".

**Row edits from the page are fenced.** Every route that edits or retires an existing row — `rebuild`, `wipe`, `resolve`, `fact-update`, `fact-expire`, `fact-restore`, `proposal-apply`, `proposal-reject`, `proposal-revise`, `proposal-prune`, `import` — accepts `expectedGeneration` and `operationId`. The run-triggering routes (`audit`, `consolidate`, `index-vectors`, `calibrate`, `extract`, `key`, `review-seen`) do not: they create proposals, derived state or a credential rather than overwrite a row a page is holding. The generation is a precondition: a page left open while another session changed the store is refused with `stale: true` and a fresh generation, so it refreshes instead of overwriting newer truth. The operation id makes a double click one write — the same id and payload returns the first receipt (`replayed: true`) without bumping the generation, and the same id with a different payload is refused as a collision. A refused write drops its operation row, so an honest retry is never mistaken for a replay.

**Forgetting.** `memory_forget` marks rows forgotten, removes them from the full-text index, and writes two tombstones: one keyed by the claim, one by the evidence. A later write or import of the same claim is refused before any row is created. Tombstones are deliberately global: a fact the user forgot must not come back through another path.

**Retrieval.** FTS5 BM25 with CJK bigrams and ASCII tokens, plus a channel that boosts exact identifiers (paths, URLs, versions, ports, package names) found in the query, fused with reciprocal-rank fusion (`k=60`). Sensitive facts and facts with `model_use_allowed = 0` never enter model-facing recall.

**Exchange.** `export` writes a manifest line plus one line per fact: UTF-8, no BOM, LF endings, atomic rename, `records_sha256` over the fact lines. `import` first previews (`new` / `duplicate` / `conflict` / `tombstoned` / `invalid`) and returns a token bound to the file hash, store id and generation; committing with a stale token is refused rather than half-applied. Imported facts are downgraded to `observed`, and sensitive ones are forced to `model_use_allowed = 0`. A record the preview classes as `conflict` is applied when asked, which puts it in the conflict queue: an import states what a file believes, not what the user affirmed. Export and import paths are confined to the data directory, and UNC paths are refused. A remote GUI reached by a hostname must name that host in `DSH_FACT_MEMORY_ALLOWED_HOSTS`; loopback and private IP literals are accepted without configuration.

**Proposals.** Some changes must not be automatic: an inferred value, a value the model is less than 60% sure of, a consolidation, an alias. Those become rows in `proposals`, each carrying the action, the target facts with their record revisions, and the evidence. Applying one is a re-check, not a replay: the target's revision is compared first, and a fact that changed, disappeared or was forgotten makes the proposal `stale` instead of overwriting newer truth. A proposal keeps a stable fingerprint and revision, so re-proposing the same change returns the existing row instead of piling up duplicates, and a value edited in the card creates a new revision that is re-validated before it can be applied. Applying writes with `confirmed_user` evidence and re-runs the privacy scan, so accepting a proposal cannot launder sensitive data into model-visible recall.

**Semantic retrieval.** Two optional channels, both pointing at endpoints you configure: embeddings (`POST <base>/embeddings`) and a reranker (`POST <base>/rerank`). Vectors are stamped with a fingerprint over provider, base URL, model, dimension, normalization and input template, and only vectors matching the current fingerprint participate — change the model and the old vectors simply stop being candidates while BM25 keeps working. Rebuilding vectors is not a button you must remember: with an embedding provider configured, a sweep rebuilds new or changed facts every `vectorIndexIntervalMs` (10 minutes by default; `0` keeps it manual), a pass that writes facts asks for a sweep right after it, and a factory reset clears the vector table together with the facts — no stale vector outlives the library it described. Each reranked score is checked against the declared `scoreMode` (0–1, logit, or native); a score outside the declared range invalidates the whole rerank rather than silently reordering. Reranking only filters when a calibration record exists: at least 20 relevant and 20 irrelevant pairs, precision ≥ 95%, recall ≥ 80%. Without it the rerank orders results but the tool reports `rerank_uncalibrated` and treats nothing as settled. The whole retrieval is budgeted (2500 ms total, 800 ms for the query embedding, 1500 ms for the rerank, a 20-candidate pool with up to 5 exact-identifier slots reserved inside it); a timeout or failure degrades to the lexical channels and says so in `paths`.

**Automatic extraction.** There is a cheap path (`autoCapture`, rule matching) and an expensive but more accurate one (a model). The model path is off by default, and its trigger is `turn/end` — **the end of a turn**, whether that turn finished with text, with tool calls only, or aborted.

The two paths never both work on the same text. When the model path would read a message, the rule path stays silent and hands that whole message to the model — otherwise one sentence becomes two facts; a duplicate the model finds later folds into the original record through the claim key. Only an explicit "remember this" still writes immediately; and when the model is not configured, or the turn is not on the model path, the rules keep covering it. A conversation transcript from a compaction or title agent (starting with `USER:` / `ASSISTANT:`) is refused by both paths — it is a retold dialogue, not the user speaking, and anything extracted from it is the assistant's own wording. Delegated subagent sessions are excluded too: their header carries `origin: "subagent"` (or a positive `delegationDepth`), the transcript is task scaffolding rather than a durable statement from the user, and the parent session stays the single writer. A child that is explicitly told to remember something can still use `memory_write`.

It runs in the background and does not hold the conversation: the event handler only enqueues the work and returns; the model call and the writes happen afterwards. Queues are per session: **strictly FIFO within a session** (an unfinished pass makes the next turn wait instead of jumping ahead or cancelling it), **parallel across sessions**. Each pass covers a fixed snapshot — the seq of the `turn/end` that triggered it is the exclusive end of that range, so a turn that appears later is not swept into an earlier pass. The snapshot's start/end seq, message count, character count and text hash are recorded in `lastRun.snapshot`, so "what did that pass actually process" stays answerable.

A signal prefilter (explicit memory requests, standing decisions and preferences, plus property-value bindings such as “port is 9911” — in Chinese and English) is the fast path, not the only path: signal-free text is not dropped, the cursor stays put, and after `extractFallbackTurns` (3 by default) or `extractFallbackChars` (800) the model reads it anyway — so "we run on 8123" is not lost forever for lacking a magic word. Without a signal, a "skipped" decision is recorded. With one, the turn's **new conversation text** goes to the model: both the user's words and the assistant's reply (the user is usually assigning work; the fact often lands in the reply — `extractIncludeAssistant` is on by default), while tool output, injected notices and compaction transcripts do not — and every candidate must carry a verbatim quote; a quote that does not occur in the input drops the candidate rather than counting as a partial success. Candidates also pass a shape gate: the subject must be a stable entity name, and sentence fragments, questions, requests and conversation meta (“above”, “my conclusion”, “the user”, “the assistant”) are refused — both paths share judgement, so they cannot disagree about what counts as a fact. The model receives text only: no tools, no session history, no write access; whether a candidate lands is decided by local code. Below the confidence floor (0.6 by default) it goes to the proposal queue. Failures retry after 1/5/30 minutes; after three the range is persisted as a pending item with its source anchors and the cursor advances. Long text is split into segments and a pass covers a few of them (`extractChunksPerPass`, 2 by default); the cursor stops in front of the unprocessed part. Segments are merged before anything is written: deduplication is local and free, and only when segments repeat or disagree does one extra model call consolidate them — an answer may only recombine the candidates it was given (field by field, or the whole answer is discarded). Thinking is off by default (`extractThinking`): extraction is mechanical and reasoning only eats the answer budget.

One known boundary: a one-shot CLI session can exit inside the delay window. Set `extractDelayMs` to `0` there; long-lived desktop/web hosts are unaffected, and a disposing agent flushes the pending pass.

**Graph.** The graph is a projection, never a second truth source: edges are derived from facts that name another entity as their value, and each edge carries the ids of the facts behind it. Only active and scheduled facts produce current edges, so forgetting or superseding a fact removes or retires its edge in the same transaction. The page offers two views: the **nebula** (default, 3D WebGL) merges entities and values into one node set, clusters it by degree and draws it on three layers — a starfield, glowing nodes, 2D labels; its budget is 600 nodes / 1200 edges, what is left out is reported as a count, and entities are capped at 300 so one fat entity cannot eat the whole budget; the **one-hop neighborhood** (100 nodes / 200 edges) is for reading relations. Contested relations appear only in the "all" view and are labelled, never shown as confirmed. Hovering reveals neighbors, and opening a node or an edge lists the supporting facts, which is how an edge is audited back to statements. Opening the graph tab always re-reads the projection — a cached map is never passed off as the current store — and the toolbar carries a manual refresh button; when WebGL is unavailable the view falls back to an SVG tree instead of a blank panel.

## Requirements

- dsh `>= 0.2.2-rc.1` (the package's `compatibility` field also caps it at `< 0.3.0-0`)
- Node `>= 22.13` (the host's own runtime qualifies; `node:sqlite` must include FTS5)

No native modules, no compilation step. The plugin makes no network call of its own until you configure an embedding, rerank or extraction endpoint — with the defaults (every channel off, `llmSource: host`) nothing leaves the machine.

## Install

```bash
cd dsh-fact-memory
npm install                     # one runtime dependency: @deepseek-ai/schemastery
dsh plugin --profile web add /absolute/path/to/dsh-fact-memory
```

The package ships a bundle patch (`cordis.patch.yml`) that inserts one row:

```yaml
- insert:
    - id: dsh-fact-memory
      name: 'dsh-fact-memory'
      config:
        dataDir: ''
        injectDirectory: true
        directoryBudget: 800
        injectReminder: true
        autoCapture: false
        searchLimit: 5
        backupBeforeExport: true
```

A row must be **inserted** (as above). A bare `- id: dsh-fact-memory` is an *override* of an existing entry and is rejected with `patch: entry "dsh-fact-memory" not found`.

Restart the host once after installing: the bundle patch is read at boot.

## Configuration

Every key is live: the settings card writes through the host's config service and the next request uses the new value; editing the profile file is just as live, no restart. The card renders every configuration key: `enabled` sits on its own at the top as the master switch, and the tuning knobs — budgets, timeouts, the time zone, backup rotation and the duplicate check — live under a folded “Advanced” section at the bottom, so the card opens on the everyday settings and unfolds the rest on demand.

| Key | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `""` | Store directory; empty means `<DSH_HOME>/fact-memory`. Pointing it elsewhere switches to another store (no migration). |
| `injectDirectory` | `true` | Put the budgeted directory into every request's dynamic context. |
| `directoryBudget` | `800` | Directory budget in tokens, converted at 2 characters per token; overflow is truncated with a count. |
| `injectReminder` | `true` | One notice per session (first turn, or a turn mentioning memory). |
| `autoCapture` | `false` | Rule-based capture of user statements. Credentials and personal data are still skipped. |
| `refuseCredentials` | `true` | Refuse writes that look like a credential. Turn it off and such a value is stored as a sensitive fact instead — still never model-visible. |
| `sensitiveModelVisible` | `false` | Let sensitive facts (phone, ID, email) enter the directory and model-facing search results. Off by default: they are stored but never shown to the model. It governs **model context only** — the library and graph pages always show your own data (a credential stays masked everywhere). |
| `searchLimit` | `5` | Default `memory_search` result count (1–10). |
| `backupBeforeExport` | `true` | Copy a consistent SQLite backup into `<dataDir>/backups` before each export. |
| `backupBeforeWipe` | `true` | Take the same backup before “Clear everything”; turning it off makes the wipe immediate. |
| `enabled` | `true` | Master switch for this store's tools, directory, extraction and time maintenance. |
| `reminderBudgetTokens` | `300` | Character budget for the per-session notice (2 characters per token); `0` injects no notice at all. |
| `searchBudgetTokens` | `1200` | Character budget for the rendered `memory_search` result. |
| `queryTimeoutMs` | `2500` | Whole-query deadline, including the optional embedding and rerank hops. |
| `storeTimezone` | `""` | IANA zone for display; empty means the host's local zone. Stored dates stay ISO UTC. |
| `backupKeep` | `7` | Keep this many export backups, deleting the oldest first. `0` keeps everything. |
| `advanceIntervalMs` | `60000` | How often scheduled facts are promoted and expired ones retired. `0` disables the timer; opening the store always advances once. |
| `embeddingSource` | `"none"` | `none` or `openai` (an OpenAI-compatible `/embeddings` endpoint). The host supplies no embedding model, so this stays off unless you configure it. |
| `embeddingBaseUrl` | `""` | Base URL of the embedding endpoint, e.g. `https://api.example.com/v1`. |
| `embeddingModel` | `""` | Embedding model id; indexing and querying must use the same one. |
| `embeddingDim` | `0` | Expected vector dimension; `0` accepts whatever the provider returns. |
| `embeddingApiKeyEnv` | `"FACT_MEMORY_EMBEDDING_KEY"` | Name the key is stored under. Paste the secret in the settings card and it goes to the host credential store; an environment variable with this name is still honoured as a fallback. |
| `rerankSource` | `"none"` | `none` or `json` (a Cohere/Jina style `POST <base>/rerank`). |
| `rerankBaseUrl` | `""` | Base URL of the rerank endpoint. |
| `rerankModel` | `""` | Rerank model id; changing it requires recalibration. |
| `rerankApiKeyEnv` | `"FACT_MEMORY_RERANK_KEY"` | Same as above, for the rerank endpoint. |
| `rerankScoreMode` | `"unit_interval"` | `unit_interval` (0–1), `logit`, or `native`; scores outside the declared range invalidate the rerank. |
| `autoExtract` | `false` | Extract facts with a model after every turn. Off by default: each extraction is one model call. |
| `llmSource` | `"host"` | `host` reuses the model this session already runs (no new credential); `custom` is a separate OpenAI-compatible endpoint, so the turn's text leaves the machine for that address. |
| `llmBaseUrl` | `""` | `custom` only: e.g. `https://api.example.com/v1`; requests go to `<base>/chat/completions`. |
| `llmModel` | `""` | `custom` only: model id. |
| `llmApiKeyEnv` | `"FACT_MEMORY_LLM_KEY"` | `custom` only: same as above, for the extraction endpoint. |
| `extractDelayMs` | `5000` | Merge window after a turn ends: another `turn/end` inside it folds into one pass (still FIFO). `0` runs immediately; prefer `0` for one-shot CLI sessions. |
| `extractConfidenceMin` | `0.6` | Below this confidence a candidate becomes a proposal instead of a fact. |
| `extractMaxChars` | `24000` | Characters per extraction (about 8000 tokens); longer text is split into segments. |
| `extractThinking` | `false` | Let the extraction model think before answering. Off by default: reasoning consumes the output budget and extraction needs none. |
| `extractMerge` | `true` | When segments repeat or disagree, make one extra model call to consolidate them. The answer may only recombine the given candidates; an invented value discards it. |
| `extractChunksPerPass` | `2` | How many segments one pass covers (1–4). |
| `extractFallbackTurns` | `3` | Signal-free text is kept this many turns (the cursor does not move); then the model reads it anyway. `0` = prefilter only. |
| `extractFallbackChars` | `800` | Signal-free text this long goes to the model at once. |
| `extractIncludeAssistant` | `true` | Read the assistant's replies too: facts often land in the reply after the work; off = only the user's own words. |
| `vectorIndexIntervalMs` | `600000` | With an embedding model configured, rebuild vectors for new/changed facts this often; `0` keeps it manual. A new fact triggers one sweep immediately. |
| `autoConsolidate` | `true` | Look for near-duplicate facts in the background: recall is the union of IDF cosine and embeddings, the verdict comes from the model, and every merge becomes a pending proposal. Safe by default because nothing is applied without a person accepting it. |
| `consolidateIntervalMs` | `21600000` | How often to look for new near-duplicate pairs (6 hours); `0` keeps it to the button and the route. |
| `consolidateCosineFloor` | `0.85` | Vector cosine at or above which a pair is worth asking the model about. Lower catches more re-phrasings and spends more calls. |
| `consolidateMaxPairs` | `8` | Model calls one sweep may spend. Each pair is judged once per vector generation, so a sweep mostly costs nothing. |
| `autoAudit` | `true` | Audit the library in the background for self-referential facts, unfolded pipelines and split entities. Each class becomes one aggregated proposal; nothing is applied without acceptance. |
| `auditIntervalMs` | `21600000` | How often the health check runs (6 hours); `0` keeps it to the button and the route. |
| `dreamEnabled` | `false` | The dream layer: a second, documentary memory that reads whole conversations and writes readable notes. It never writes a fact and keeps a verbatim feed only while it is on, so it is off by default. |
| `dreamInjectMode` | `cue` | `cue` = when the current message names an accepted note’s topic, inject one line saying the note exists (no prose, never presented as fact); `off` = silent. Search still covers facts only. |
| `dreamFocus` | `""` | One sentence that goes into the pass prompt, e.g. only the troubleshooting path and its conclusion. |
| `dreamMinChars` | `10000` | Unorganized characters that make an automatic pass worth running. |
| `dreamMinSessions` | `3` | Sessions that count toward the trigger, together with a 2000-character floor. |
| `dreamEventTrigger` | `true` | Let a single large turn trigger a pass without waiting for the accumulation thresholds. |
| `dreamEventMinChars` | `6000` | New characters in one turn that count as an event. |
| `dreamIdleFloorDays` | `7` | Idle fallback: after this many days with enough material, run anyway. |
| `dreamIdleFloorChars` | `2000` | Material the idle fallback needs. |
| `dreamMinGapMs` | `21600000` | Minimum gap between automatic passes; the manual button ignores it. |
| `dreamDailyCap` | `2` | Automatic passes per local calendar day; manual runs do not count. |
| `dreamMaxChars` | `40000` | Characters one pass may read; the rest stays waiting for the next pass. |
| `dreamMaxDreams` | `5` | Notes one answer may keep; extras are dropped and counted. |
| `dreamFeedRetentionDays` | `30` | Days an unconsumed feed row is kept; `0` keeps it forever. Accepted notes are never touched. |
| `dreamArchiveAfterDays` | `90` | Days without a cue before a live note is archived. Archiving is a status, not a delete: the row, its sources and its timeline stay, and the tab restores it. `0` = never. |
| `dreamBackfillMaxSessions` | `50` | Old sessions one manual backfill may read (newest first). Sessions already collected are skipped. |
| `dreamBackfillMaxChars` | `200000` | Characters one manual backfill may copy into the queue. |

Override example (a profile patch layer):

```yaml
- id: dsh-fact-memory
  name: 'dsh-fact-memory'
  config:
    directoryBudget: 1200
    autoCapture: true
```

## The dream layer

Facts are one statement in a slot. A dream is the other kind of memory: prose distilled from a stretch of conversation — what was tried, what failed and why, where the work stopped. It is stored in its own tables, it never writes a fact, and it is **off by default**.

How a pass works:

1. **Collect.** While the layer is on, each finished turn is appended to a feed verbatim (`dream_feed`), together with a per-session high-water mark; a restart resumes exactly where the last process stopped.
2. **Decide.** A pass runs only when the material is worth it: 10,000 unorganized characters, or 3 sessions with 2,000 characters, or one turn that added 6,000 characters, or a 7-day idle fallback with 2,000 characters. Damping comes first: at least 6 hours between passes and at most 2 automatic passes per local day. A manual run ignores the thresholds but not the switch.
3. **Distill.** Whole sessions are packed into one bounded prompt (40k characters per pass); sessions with fewer than three user messages are left in the feed for later (when every session is that thin the floor drops to one, or the feed would stay lit forever without ever producing material). Lines that look like secrets or private data are dropped before the model sees anything.
4. **Validate.** The answer is checked locally: at most 5 notes, topic keys in `[a-z0-9-]`, no re-statement of an existing topic without new material, at least one source that really appears in the material, duplicate bodies refused. A note carrying an identifier that does not occur in the material is kept but flagged `unverified`.
5. **Review.** Every note lands as `pending`. Accepting (or editing and accepting) moves it to `active`; rejecting remembers the topic so it is not proposed again. Nothing reaches the library without that click, and the fact count is identical before and after any pass.

Two copy semantics keep the layers apart: a dream is never searchable through `memory_search` and never injected as a fact. With `dreamInjectMode: "cue"` the only model-facing surface is one line saying that a related note exists and naming its topic; `off` silences even that.

Privacy: the feed is a second copy of the conversation, so it only exists while the layer is on, it is pruned after `dreamFeedRetentionDays` (30) days if unconsumed, it disappears once a pass consumes it, and a factory reset clears it with the rest.

### Time, heat and history

A note carries two clocks, the same pair the fact table uses. **Transaction time** is `created_at`/`updated_at` — when the material was read. **World time** is `valid_from`/`valid_to` — when the thing it describes was true: `valid_from` is the earliest message the note covers, and accepting a note that replaces another closes the old one's window at the moment the replacement was said. Nothing is deleted on replacement, so the tab can read the timeline instead of guessing which version is current.

**Heat** is measured, not modelled: `hit_count` rises when a real message triggers the cue for a note, and `last_hit_at` records when. There is no decay constant — a made-up curve would look precise and mean nothing. What the number decides is the topic index order, and, with `dreamArchiveAfterDays` (90 by default), whether a note is archived: an active note nobody has touched in that many days moves to `archived`, which is a status and not a delete — the row, its sources and its timeline stay, the cue and the index stop offering it, and the tab restores it in one click.

**The topic index** at the top of the tab is generated by rule from the live notes (at most 20 lines): title, key, hit count, and the date the note starts. It is a map of what exists, never a summary of what it means.

**History backfill** is manual and never automatic. `POST /api/fact-memory/dream-backfill` with `{"backfill": true}` reads session archives under `<DSH_HOME>/sessions` (multi-frame zstd, newest first), filters the same secrets and private data, drops compaction summaries (a summary of a summary is not something anyone said), and copies up to `dreamBackfillMaxSessions` (50) sessions / `dreamBackfillMaxChars` (200000) characters into the feed. Sessions the layer already collected are skipped, so running it twice copies nothing twice; after it lands, the normal thresholds decide when to distill.

The **Dreams** tab shows what is waiting, what was accepted, the line explaining why the next pass is or is not due, and a manual "Organize now" with an optional focus sentence.
## Data on disk

```
<dataDir>/
  memory.db               the store (memory.db-wal / -shm appear beside it while open)
  backups/                copies taken before exports and before a wipe
  exports/facts-*.jsonl   human-editable exports
```

Everything is plain SQLite and plain JSONL: you can read, edit and re-import it without this plugin.

## Development

```bash
npm install
npm test                      # the full suite, node:test
```

If the local `node` predates `node:sqlite`, run the suite with the host's own runtime:

```bash
ELECTRON_RUN_AS_NODE=1 "/path/to/DeepSeek Harness" --test tests/*.test.js
```

```
index.js          plugin entry: config schema, tools, dynamic context, hooks, routes
client.js         the sidebar page, the settings card and the conversation surfaces (host module loader, no build step)
src/schema.js     DDL, schema versioning, integrity check
src/store.js      transactions, claim keys, slot rules, tombstones, receipts, backup
src/extract.js    rule-based extraction (11 rules plus a catch-all note; every candidate passes the quality gate)
src/quality.js    fact-shape judgement: counter-example lists for subject/predicate/value (fragments, questions, requests, meta)
src/dedup.js      dedupe before writing: subject canonicalization, IDF-weighted cosine, rare-token veto
src/retrieve.js   BM25 + identifier + vector channels, RRF, rerank, rendering
src/semantic.js   embedding/rerank providers, fingerprints, vector index, calibration
src/proposals.js  the review queue: create, fence, apply, reject, revise
src/audit.js      the health check: self-referential facts, unfolded pipelines and split entities, as aggregated proposals
src/consolidate.js near-duplicate review: candidate pairs, the model's closed question, merge proposals
src/graph.js      one-hop neighborhood and nebula projection derived from facts, with edge evidence
src/autoextract.js extraction prompt, signal prefilter, candidate validation (quote anchors), chunking
src/llm.js        model calls: the host streaming runtime, or a custom OpenAI-compatible endpoint
src/inject.js     directory and notice text
src/jsonl.js      export/import with manifest, hashes and preview tokens
src/routes.js     same-origin JSON route registration
src/util.js       normalization, tokenization, identifier parsing, secret/privacy scans
tests/            store, time, extract, quality, dedup, retrieve, jsonl, proposals, graph, semantic, autoextract, consolidate, audit, apply, client, routes, docs
```

## Scope of this version

Deliberately absent, so nobody expects them:

- no embedding model shipped or bundled: the vector and rerank channels exist, but they are off until you point them at an endpoint, and every result says which channels actually ran;
- model extraction is off by default and always text-only: the model gets no tools, no session history, and no write access; anything below the confidence floor becomes a proposal, never a silent row, and a candidate whose quote is not in the input is dropped;
- no bulk maintenance tools: the page covers browsing, editing, expiring, proposals, conflicts and the one-hop graph, but there is no multi-select editor, no cross-entity rewrite, and no data-exchange packages beyond one fact JSONL file;
- no cross-device sync; JSONL export/import is the exchange format;
- no automatic conflict resolution on import: imported conflicts enter the queue and wait for a human;
- no automatic graph expansion into prompts: the graph is read on demand, never injected as neighbor context.

## License

MIT
