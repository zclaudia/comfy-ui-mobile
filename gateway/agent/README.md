# Workflow agent MVP

The Gateway now hosts a Vercel AI SDK agent, SQLite task/version/event storage,
ComfyUI execution polling, and authenticated APIs. The App entry is the **对话**
tab (`/chats`); each session binds to one workflow in the App library.

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

The system prompt (`gateway/agent/prompts.ts`) and the tool schemas are a stable
prefix: they depend only on the profile's vision flag, never on the session or the
step. Everything that changes per step — session version, current workflow, last
execution result, remaining call/preview budget and the preview policy — is sent as
a trailing `[Session state]` user message that is rebuilt every call and never
persisted into the task history. Provider prefix caches therefore cover the system
text, tool definitions and the conversation so far instead of being invalidated
each step. Keep it that way: add volatile facts to `stepState`, not to the system
prompt, and keep the tool object's key order deterministic.

## Preview confirmation

Each session has a preview policy. `auto` (default) lets `submit_preview` run as
soon as the model calls it. `confirm` (**⋯ → 生成前确认** in the chat header) validates
the submission, then parks the task in `waiting_user` with a card in the chat; the
model is told to wait and is not called again. **Run** or **Skip** records the
decision and re-queues the task; the scheduler performs the submission itself (so a
crash between the decision and the ComfyUI POST is recovered like any queued step)
or tells the model the user declined. Time spent waiting is credited back to the task
deadline. Stopping the task while it waits cancels it as usual. A held task still
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
`create_model_workflow` creates one of: `z-image-turbo`, `z-image-turbo-hires`,
`h3-fl2va`, `h3-fl2va-lite`, `h3-ref-image`, `h3-ref-audio`, `h3-ref-video`.
The fixed profiles match the reviewed model filenames and combinations. FL2VA
can select the installed Q5/Q6 variant. Reference templates require an explicit
`referenceImage`, `referenceAudio` or `referenceVideo` filename already uploaded
through ComfyUI/the App. The agent never chooses private reference assets for the
user. The chat composer supports user-selected attachment uploads.

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
| GET/POST `/sessions` | List own sessions with `preview`, `lastMessage`, `lastActivity`, `active`, `lastState`, `workflow`, `thumbnail` / create with optional canvas copy and `workflow` binding `{id, name, filename?}` (the binding name becomes the session name) |
| GET `/sessions/:id?after=N` | Snapshot plus up to 200 events after cursor N |
| POST `/sessions/:id/messages` | `{requestId: UUID, message?, attachments?: [{filename, subfolder?, type?: 'input'\|'temp', kind: 'image'\|'video'\|'audio'\|'file', name?, size?, width?, height?}]}` (max 8; message or attachments required; `width`/`height` come together, read locally by the App for images and videos, and are described to the model with the orientation so it can check fit before wiring a reference); files are uploaded to ComfyUI's input folder by the App beforehand and described to the model as loader-node paths; with vision enabled on the task’s model profile up to 4 PNG/JPEG/WebP/GIF attachments (≤5MB each, ≤16MB together; larger files stay path-only) are also sent to the model as image input for that task's own message, fetched from ComfyUI once per task and never persisted in task messages; idempotent request ID, one active task per session |
| POST `/sessions/:id/cancel` | `{taskId}` |
| POST `/sessions/:id/approve` | `{taskId, callId, approved}`; answer a held `submit_preview` (409 unless the task is `waiting_user` for that call) |
| GET `/sessions/:id/versions/:version` | Read immutable canvas/version |
| POST `/sessions/:id/save` | `{version}` |
| POST `/sessions/:id/restore` | `{version, baseVersion}`; create a new version when no task is active |
| PATCH `/sessions/:id` | `{name?, workflow?: {id,name,filename?} \| null, previewPolicy?: 'auto' \| 'confirm'}`; binding a workflow also renames the session unless `name` is given |
| DELETE `/sessions/:id` | Cancel active tasks, then delete the session with its tasks, versions and events |
| POST `/sessions/:id/versions` | `{canvas, baseVersion, summary?}`; commit the App canvas as a new version (422 when unsupported, 409 on stale base or active task) |

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

For local browser checks after building:

```sh
node_modules/.bin/tsx gateway/agent/test/uiHarness.ts
```

This test-only harness prints a local URL and uses temporary storage, a synthetic
model and synthetic ComfyUI server. Log in to that isolated URL with the fixture
token `local-agent-ui-test-token`; never use it for a deployed Gateway. Create a
session and send a message to run the scripted template/edit/preview/save flow.
Stop with Ctrl-C to remove its temporary data. The synthetic image is explicitly
labelled as a test preview. The script is excluded from the production agent build.

Live provider smoke test (explicit external-call opt-in):

```sh
AGENT_LIVE_TEST=1 node --env-file=gateway/.env --import tsx gateway/agent/test/liveSmoke.ts
```

This uploads a generated 64px fixture to ComfyUI, asks the real model to repair an
invalid filename, validates, runs one copy preview and saves the version. Reports
and isolated SQLite data go to `tests/output/agent-live/`. It does not use existing
user images. On 2026-09-05, MiniMax-M3 completed the real copy/save path in 6 model
calls; the output was independently retrieved and verified as a 64×64 PNG. A
previous 1px fixture triggered a ComfyUI decoding error, which the model reported
accurately without retrying beyond the one-preview budget.

Remaining acceptance gate: actual text-to-image generation and image-quality
evaluation with a compatible installed checkpoint. The tested ComfyUI instance
currently exposes no checkpoint choices for the basic template; diffusion-loader
models require another template/codec. Mock and copy tests do not establish
text-to-image quality or broad workflow compatibility.
