# Workflow agent MVP

## Multi-draft workspace

The chat is a multi-draft workspace: independent drafts and revisions, durable
assets, Run-based execution and recovery, structured request context, persisted
selection cards, and draft-scoped HTTP/tool contracts. The chat UI offers creation
and reference selection, independent result cards, preview confirmation, history and
source details, plus paginated session search and archive restoration. Editable draft
canvases support mobile/official switching, local recovery and conditional
synchronization. Library saving uses fixed revisions, materialized references, ETag
checks and server readback.

The pre-draft single-workflow chat (schema version 1) and its migration path were
removed in 0.4. This Gateway refuses to open a database that still holds unmigrated
pre-draft sessions, and the app refuses to talk to a Gateway that does not report
`agentSchemaVersion: 2`. Design and acceptance history live in
[`the design doc`](../../docs/agent-conversation-workspace-design.md) and
[`the implementation record`](../../docs/agent-conversation-workspace-implementation.md).
Scripted provider tests verify orchestration, not real model intent resolution or
GPU/video quality.

For isolated V2 browser checks (requires `ffmpeg`), run:

```sh
npm run build:agent
node_modules/.bin/tsx gateway/agent/test/workspaceUiHarness.ts
# In another terminal; match the URL printed by the harness if overriding its port:
VITE_GATEWAY_TARGET=http://127.0.0.1:53023 npm run dev -- --host 127.0.0.1 --port 5187
```

Open `http://127.0.0.1:5187/settings/server` and connect with fixture token
`local-workspace-ui-test-token`. The harness uses temporary data and a scripted
model, solid-colour PNGs and a one-second test-pattern video. It can exercise the
image/video/edit-image/update-video sequence, exact-parameter reruns and confirmation;
the message `选择测试` exercises a persisted selection card. It does not evaluate
natural-language understanding or visual generation quality. Ctrl-C removes only
its temporary fixture directory. `WORKSPACE_UI_PORT` can override the gateway port;
the allowed browser origin stays `http://127.0.0.1:5187`.

Real model/GPU checks are opt-in and must use a separate V2 database and media
directory. With that Gateway already running, supply its URL and test token:

```sh
E2E_WORKSPACE_LIVE=1 E2E_GATEWAY_URL=http://127.0.0.1:53038 E2E_GATEWAY_TOKEN=YOUR_TEST_TOKEN node tests/e2e/workspace-live.e2e.mjs
E2E_WORKSPACE_LIVE=1 E2E_GATEWAY_URL=http://127.0.0.1:53038 E2E_GATEWAY_TOKEN=YOUR_TEST_TOKEN node tests/e2e/workspace-reference-live.e2e.mjs
```

The first script performs four real image/video rounds; the second checks a
two-image batch, natural-language selection of its second image, and an independent
fork without generation. Reports retain request IDs, task IDs, snapshots and complete
terminal event pages under `tests/output/workspace-live/`. A failed or timed-out
observation never automatically replays a POST; inspect the saved task first.
Visual fidelity must be checked separately from successful execution and binding.

Workspace configuration:

```dotenv
AGENT_WORKSPACE_SERVER_ID=main-comfy
# Defaults to assets/ alongside GATEWAY_AGENT_STORE, keeping both in the same persistent volume.
# AGENT_WORKSPACE_MEDIA_DIR=/data/assets
```

`AGENT_WORKSPACE_SERVER_ID` is required whenever the assistant is enabled. It must
identify the actual configured ComfyUI connection and stay stable for the life of the
database: stored source references and library-save targets are matched against it.
Mutating requests require `X-Agent-Schema-Version: 2`.

Deploy the matching Gateway, client, and ComfyUI extension together. Official draft
canvases require both `fe/mobileBridge.js` and `fe/managedExecution.js` from
`comfy-mobile-ui-api-extension`; an older bridge cannot provide managed execution
and the client keeps generation disabled until its handshake succeeds. The local
acceptance proxy's JS overlay is a test fixture, not a production extension install.
Keep the database and asset directory on persistent storage and preserve both in
backups. Reasoning-model request timeouts are configurable per profile; the latest
local qwen3.8 acceptance uses 240 seconds after 90-second calls repeatedly timed out.

Managed draft iframes obtain a short-lived read capability using authenticated
`POST /api/gateway/canvas-access`. The returned path is
`/comfy/_access/<id>/`; the native device token stays in parent API headers.
Authenticated `POST /api/gateway/canvas-access/:id/renew` extends the same lease
(default lifetime 30 minutes, renewal interval 10 minutes), without reloading the
iframe. `DELETE /api/gateway/canvas-access/:id` revokes that read capability and
closes its WebSockets. Possession permits revoking only that capability; renewal
requires normal authentication and the same principal. Browser logout revokes its
leases, expired or invalid original credentials fail subsequent validation, and
Gateway restart invalidates all in-memory leases. The underlying ComfyUI route
allowlist and managed-asset ownership checks remain in force. Capability requests
allow GET/HEAD only; generation remains a parent Workspace Run operation.
Treat these paths as temporary read credentials when configuring access logs.
This mechanism currently applies to managed draft canvases; legacy library iframe
behavior is unchanged. A renewal failure retains the mounted editor and displays a
connection error so the user can switch back to the mobile editor before reopening.

Canvas clients also send `X-Agent-Server-Id` with the URI-encoded stable server ID.
When present, the workspace API rejects both reads and writes if this identity differs
from the configured backend. This guards locally cached drafts when a connection URL
starts serving another ComfyUI environment. CORS preflight allows both headers.

`POST /sessions/:sid/drafts/:did/discard-local` accepts the original optional
`pending` save and `fork` local-fork payloads. It checks their exact command digests
and records uncommitted request IDs in `workspace_request_cancellations` within
one transaction. Late submissions with those IDs are rejected. Committed revisions
and forks remain intact; the response includes the current revision and any committed
results. Preserve the cancellation table with the workspace database when backing up
or restoring it. Cancellation does not execute the supplied canvas or start a Run.

Use `POST /sessions/:sid/drafts` with either
`{source:"template",requestId,name,template:{templateId,text,references?}}` or
`{source:"canvas",requestId,name,canvas,bindings}`. Messages carry
`{requestId,message,context:{targetDraftId?,sourceRevision?,selectedAssetIds?,action?}}`.
Reference slots come from template inspection; file paths are never asset identities.
The exact implemented endpoints are in `workspace/routes.ts`. Library save intents,
client writes and server readback are implemented and have been checked against
the actual file extension with separate image/video test files and a concurrent
ETag conflict. Archived-session cleanup preserves pinned/shared provenance and
retries failed blob deletion through a durable operation. See the implementation log.

A database that still contains pre-draft sessions cannot be opened by this build:
the service refuses to start rather than half-reading it. Export anything worth
keeping with a 0.3 Gateway, then clear those sessions (`sessions`, `versions`,
`events`, `tasks`, `session_context`, `receipts`, `version_requests`) before
upgrading; `agent_settings` holds the model profiles and should be kept. Rolling back
to 0.3 requires restoring the pre-upgrade database together with the old executable
and client; preserve any workspace media and rows written since the upgrade first.

The Gateway hosts a Vercel AI SDK agent, SQLite session/task/event storage plus the
workspace tables, ComfyUI execution polling, and authenticated APIs. The App entry is
the **对话** tab (`/chats`); a session owns any number of drafts, each with its own
revision history, and records which library workflow a draft started from and where
the user last saved it. Nothing reaches the library without an explicit save.

## Run locally

Requires Node.js **22.13 or newer** (uses `node:sqlite`). Install both dependency
sets, then build the Gateway modules and frontend:

```sh
npm ci
npm --prefix gateway ci
npm run build:agent
npm run build
node --env-file=gateway/.env gateway/index.js
```

`npm run gateway` builds the agent first and loads `gateway/.env` if present;
existing process environment variables take precedence. The Docker
image builds and copies the compiled agent. Both Compose files persist its SQLite
database under `/data/agent.sqlite` using the existing volume.

Enable in `gateway/.env`:

```dotenv
GATEWAY_AGENT_ENABLED=true
GATEWAY_AGENT_STORE=gateway/.data/agent.sqlite
AGENT_LLM_BASE_URL=https://your-provider.example/v1
AGENT_LLM_MODEL=your-tool-capable-model
AGENT_LLM_API_KEY=your-api-key
AGENT_LLM_VISION=true
AGENT_LLM_CONTEXT_WINDOW=32768
AGENT_LLM_MAX_OUTPUT_TOKENS=2500
AGENT_MAX_STEPS=12
AGENT_MAX_PREVIEWS=3
AGENT_TIMEOUT_MS=1200000
AGENT_STEP_TIMEOUT_MS=90000
AGENT_CONCURRENCY=1
AGENT_RETRIES=3
AGENT_RETRY_DELAY_MS=5000
```

The initial provider adapter uses **OpenAI-compatible Chat Completions**, via
`@ai-sdk/openai-compatible`; the provider must support tool calling. This does not
require using OpenAI as the provider. Native provider protocols can be added at
the model factory boundary. No real provider credentials were used during MVP
initial implementation. Subsequent live testing with MiniMax-M3 verified actual
tool calls, filename repair, ComfyUI image-copy execution, output retrieval and
version saving. Enable the agent on the Gateway, then manage language models in
**Chats → Assistant models** (`/settings/agent`) or from the model label above the
chat composer. No configured model means `providerReady:false`; session/version
management remains available and model tasks return HTTP 503. API keys are optional
for local providers without authentication.

## Language models and context memory

The App supports adding, editing, activating and deleting up to 30 models. Each
profile has a display name, Chat Completions model ID, API base URL, optional key,
context window (8,192–2,000,000 tokens), output limit (256–128,000, at most one quarter
of the window), an explicit vision toggle, a per-call step timeout (30–1800 s,
default 90; reasoning models usually need 300 s or more) and a completion-audit
toggle (default on). Enter limits supported by the actual provider; these fields do
not increase its capabilities. New profiles default to 32,768 tokens, 2,500 output
tokens and vision off.

The completion audit re-checks a text-only answer with one extra forced tool call
before exposing it as final, so a model that answers "I will submit it" cannot end
a task without acting. It costs one model call per final answer. Turn it off for
models with reliable tool calling; profiles saved before the toggle existed keep
auditing.

Existing `AGENT_LLM_*` environment settings are imported **once**, when managed
settings are initialized. Thereafter App settings take precedence and survive
Gateway restarts; deleted profiles are not re-imported. Environment bootstrap keeps
the previous vision default (on). Profiles and keys reside in the Gateway SQLite
database with owner-only file permissions. APIs return `hasApiKey`, never the key.
An omitted key retains the existing value; an empty key clears it. Changing the
endpoint requires an explicit key entry or clear, preventing accidental forwarding
of a retained key to another endpoint. Backups of this database contain credentials.

The active profile is shared across authenticated devices. Each new task pins its
model ID. Activating another profile affects subsequent messages, including in
existing chats; editing/deleting a profile used by an active task returns HTTP 409.
No Gateway restart is required. Vision-off profiles receive attachment paths only;
vision-on profiles can also receive up to four supported images for the current task.

Every model step reserves system text, actual tool JSON schemas, the session-state
message, output tokens, image headroom (4,096 tokens per image) and a safety margin.
Text accounting starts from a conservative UTF-8 estimate, **not an exact provider
tokenizer**; after each real call the ratio between the provider's reported input
tokens and that estimate is blended into a per-profile multiplier (clamped to
0.4–2.5, persisted in the database, skipped for small or image calls), so compaction
triggers closer to the real limit as a profile is used. At 85% of the configured
window minus these reservations, older history is summarized by the same model. Recent complete exchanges and the exact current request are retained; tool
calls/results are never split in the retained conversation. Oversized tool exchanges
are summarized in bounded text chunks. The memory prompt preserves goals,
constraints, asset paths, verified actions, results and remaining work, while marking
history as untrusted data. Summary quality still depends on the configured model.

Compacted task context is persisted before the next action call. Terminal tasks save
a session checkpoint and event cursor, so subsequent turns and restarts reuse memory
and only append new conversation events. Existing sessions initially read all user
and assistant events, without the former 20-message/8,000-character cutoff. Full
transcript events and workflow versions are not deleted by compaction.

The App shows compaction progress and completion. Summary calls have separate
`usage` events (`purpose: compaction`); action usage includes model/context metadata.
Summaries consume model tokens and share the task cancellation/deadline. Empty or
oversized summaries and inputs that cannot fit fail explicitly without silently
throwing history away. Work per compaction pass is bounded to 48 calls and the
existing step timeout. A recognized provider context rejection retries once with a
smaller budget; authentication/network errors do not trigger compaction retries.

## Prompt layout and caching

The workspace system prompt (`gateway/agent/workspace/prompts.ts`) and the tool
schemas are a stable prefix: they depend only on the profile's vision flag and on
whether the step is a completion review, never on the session or the step number.
Everything that changes per step — the workspace state, remaining call/preview budget
and the preview policy — is sent as a trailing `[Workspace state]` user message that
is rebuilt every call and never persisted into the task history. Provider prefix
caches therefore cover the system text, tool definitions and the conversation so far
instead of being invalidated each step. Keep it that way: add volatile facts to
`WorkspaceRuntime.state`, not to the system prompt, and keep the tool object's key
order deterministic. `gateway/agent/test/scheduler.test.ts` asserts this.

## Preview confirmation

Each session has a preview policy. `auto` (default) lets a Run submit as soon as the
model asks for it. `confirm` (**⋯ → 生成前确认** in the chat header) prepares the Run,
then parks the task in `waiting_user` with the Run card offering **确认生成** and
**跳过此次生成**; the model is told to wait and is not called again. The decision is
posted to `POST /sessions/:id/approve` with `{taskId, runId, approvalDigest, approved}`
— the digest pins the exact revision and inputs the user saw — and the scheduler
performs the submission itself, so a crash between the decision and the ComfyUI POST
is recovered like any queued step. Time spent waiting is credited back to the task
deadline. Stopping the task while it waits cancels it as usual; a held task still
blocks new messages in that session until it is answered or stopped.

## Scheduling, retries and timeouts

- `AGENT_CONCURRENCY` (1–8, default 1) bounds model calls in flight across sessions;
  a session is always serial, and a step in flight owns its task so ComfyUI polling
  never races it.
- Transient provider failures — HTTP 408/409/429/5xx, network errors, and the step
  timeout — re-queue the step with delays of `AGENT_RETRY_DELAY_MS × 3^n` up to
  `AGENT_RETRIES` times (default 3) and a `retry` event the App shows inline. A call
  the provider rejected outright does not count against `AGENT_MAX_STEPS`.
  Authentication and validation errors (4xx other than the above) never retry, and
  a task that already handed work to ComfyUI is never re-run.
- `AGENT_STEP_TIMEOUT_MS` (default 90 s) bounds one model call including its tool
  execution; a profile's step timeout overrides it.

## Scope

- Natural-language tasks use `generateText` with one tool-calling step per durable
  scheduler turn. Vercel AI SDK performs tool validation, invocation and response
  formatting; our runner persists progress between steps.
- Start from reviewed Z-Image Turbo, MiniMax H3, or classic checkpoint templates,
  or import a supported existing workflow as an independent copy.
- Inspect installed supported nodes/model options, read node schemas, edit
  parameters/reconnect existing nodes, validate, preview, repair errors within
  limits, and mark versions saved.
- Every preview links to its exact immutable workflow version. The App can save,
  restore, view changes and open a version as a separate local canvas workflow.
- Sessions, tasks and ordered events survive browser disconnection and Gateway
  restart. The App polls with an event cursor, deduplicates events and drains
  pagination. Generation does not depend on an open chat HTTP request.
- Queue/history polling suspends model calls during GPU execution. A failed
  ComfyUI run returns its diagnostic to the model for bounded repair.
- Submission intent includes a unique attempt ID. An ambiguous POST is reconciled
  against queue/recent history without re-posting. An unknown or non-unique match
  stops the task for manual inspection. History eviction or a server that omits
  extra_data can prevent recovery; we do not promise exactly-once execution.
- Cancellation stops further agent operations and aborts in-flight model/HTTP
  requests. Already-submitted GPU work may continue. This MVP deliberately does
  not call ComfyUI's global `/interrupt`, which could stop another task.

## Limitations

Canvas support uses explicitly reviewed codecs for classic core nodes, Z-Image
separate loaders, and H3 GGUF/conditioning/sampling/video/audio nodes. Flat 0.4
workflows preserve note nodes, layout and UI-only seed controls. Subgraphs, bypass,
arbitrary node addition/deletion and advanced SaveVideo encoding widget layouts
remain unsupported. H3 dimensions must be multiples of 32 and frame counts 17k+5.

`search_templates` and `inspect_environment` report installed-model availability.
`create_workflow` creates one of: `z-image-turbo`, `z-image-turbo-hires`,
`z-image-turbo-img2img`, `h3-fl2va`, `h3-fl2va-lite`, `h3-ref-image`, `h3-ref-audio`,
`h3-ref-video`. The fixed profiles match the reviewed model filenames and
combinations. FL2VA can select the installed Q5/Q6 variant.

Reference templates bind assets, never file paths: the request context carries
`selectedAssetIds` the user picked in the chat, and `create_workflow` / `edit_workflow`
attach them to a node input through `references` / `bindingChanges`. The runtime
materializes an asset into ComfyUI's input folder when a Run is compiled, verifying
the bytes against the stored blob digest, and records the exact file in the Run's
input manifest. The agent never chooses a reference asset for the user; ambiguity is
resolved with `request_selection`, which persists a selection card in the chat. A
conversation can therefore generate an image and use that image in a video Run later
without any download/re-upload step, and an old Run keeps pointing at the asset it
actually used.

Z-Image defaults to 1024 square (hires: 2048×1152), 8 steps, CFG 1. H3 defaults to
864×480, 22 frames at 24fps (about 0.92s), with the reviewed LoRA/scheduler. Longer
clips increase memory and runtime; these defaults are smoke previews, not a
quality recommendation. Model weights are neither installed nor downloaded by
the agent. H3 video results contain audio; the App also supports standalone audio
outputs from imported supported workflows.

The language model receives text, schemas and execution diagnostics. With vision
enabled it also receives supported images attached by the user, but generated output
media is not automatically fed back to the model. Reference media goes to local
ComfyUI execution. Image,
video and audio quality still requires user evaluation.

Use **one Gateway process per database**. The MVP uses short synchronous SQLite
transactions and at most `AGENT_CONCURRENCY` model requests at a time across
sessions. GPU waits are polled on the scheduler interval independently of model
steps. API graphs and event pages are bounded, but automatic retention and
multi-process workers are not implemented. Back up the SQLite database using
a SQLite-aware backup or after stopping the Gateway (include WAL if copying live).

The existing Gateway is not an account system. Setup-token logins, browser logins
and registered native devices share one administrator workspace and model settings.
Per-device identities retain separate rate-limit buckets. Anonymous Gateway
access does not authorize agent APIs. Reuse of the existing shared ComfyUI media
proxy is not a new multi-tenant media-isolation guarantee.

## API

All paths start with `/api/gateway/agent`; use existing cookie/device authentication.

| Method/path | Behavior |
| --- | --- |
| GET `/status` | Enabled/provider status, active `modelId`, model, vision, context/output budgets; no secrets |
| GET `/models` | `{models, activeId}` with redacted profiles and `hasApiKey` |
| POST `/models` | Create `{name, model, baseUrl, apiKey?, contextWindow, maxOutputTokens, vision, completionAudit?, stepTimeoutSeconds?}`; first model becomes active |
| PUT `/models/:id` | Replace profile fields; omitted key retains, empty key clears; 409 while used by active tasks |
| POST `/models/:id/activate` | Select the default for subsequent messages; returns model list |
| DELETE `/models/:id` | Remove unused profile/key; if active, select the first remaining model or none |
| GET/POST `/sessions` | Paginated session list (`before`, `limit`, `archived`, `search`) / create `{name}`; drafts are imported afterwards |
| GET `/sessions/:id?after=N` | Snapshot: session, first pages of drafts and runs, tasks, pending selections, events after cursor N and the event high-water mark |
| PATCH/POST `/sessions/:id` | `{name?, previewPolicy?: 'auto'\|'confirm', archivedAt?: number\|null}` / `cleanup` plans and executes permanent deletion of an archived session |
| POST `/sessions/:id/messages` | `{requestId: UUID, message, context: {targetDraftId?, sourceRevision?, selectedAssetIds?, replyToEventSeq?, action?}}`; idempotent request ID, one active task per session |
| POST `/sessions/:id/cancel` | `{taskId}` |
| POST `/sessions/:id/approve` | `{taskId, runId, approvalDigest, approved}`; answer a held Run (409 unless the task waits for that Run) |
| POST `/sessions/:id/selections/:qid/answer` | `{taskId, selectedIndices, answer?}`; answer a persisted selection card |
| GET/POST `/sessions/:id/drafts` | Paginated drafts (`kind`, `archived`) / import `{source:'template'\|'canvas', …, requestId}` |
| GET/PATCH `/sessions/:id/drafts/:did` | Draft summary / `{name?, archivedAt?}` |
| GET/POST `/sessions/:id/drafts/:did/versions` | Paginated revisions / commit a canvas edit against `expectedHeadRevision` |
| GET `/sessions/:id/drafts/:did/versions/:rev` | One immutable revision with its bindings |
| POST `/sessions/:id/drafts/:did/{restore,fork,fork-local,discard-local}` | Revision history operations, each idempotent by `requestId` |
| GET/POST `/sessions/:id/runs` | Paginated runs (`draftId`) / start an explicit Run `{draftId, revision, requestId}` without the model |
| GET `/sessions/:id/runs/:rid[/assets]` | One Run and the assets it produced |
| GET/POST `/sessions/:id/assets` | Paginated assets (`kind`, `runId`, `draftId`) / register an uploaded file as an asset |
| GET `/sessions/:id/assets/:aid[/content\|/uses\|/library-uses]` | Asset detail, authenticated bytes with Range support, and where it was used |
| POST `/sessions/:id/drafts/:did/library-saves` and `/sessions/:id/library-saves/:opId/{prepare,applying,reconcile,cancel}` | Library save intent, client write and server readback |

The exact request and response shapes live in `gateway/agent/workspace/routes.ts`.

## Verification

```sh
npm run test:agent
npm run test:gateway
npm run build
```

Tests exercise the actual AI SDK with `MockLanguageModelV3`, durable state,
execution failure/repair, uncertain submission, restart, cancellation, budgets,
authentication/device isolation and workflow round trips. No real GPU or external
LLM calls occur.

For local browser checks, use the workspace harness documented at the top of this
file (`gateway/agent/test/workspaceUiHarness.ts`): it prints an isolated URL backed by
temporary storage, a scripted model and a synthetic ComfyUI server, and it is excluded
from the production agent build.

Real model and GPU checks are opt-in and run against an isolated Gateway:
`tests/e2e/workspace-live.e2e.mjs` performs four real rounds (image → video → edit
image → update video) and `tests/e2e/workspace-reference-live.e2e.mjs` checks batch
selection and an independent fork. Both write evidence under
`tests/output/workspace-live/`. A failed or timed-out observation never replays a
POST automatically; inspect the saved task first. Visual quality always needs
separate human review.
