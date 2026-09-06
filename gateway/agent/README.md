# Workflow agent MVP

The Gateway now hosts a Vercel AI SDK agent, SQLite task/version/event storage,
ComfyUI execution polling, and authenticated APIs. The App entry is **工作流助手**
in the side menu (`/agent`).

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
AGENT_MAX_STEPS=12
AGENT_MAX_PREVIEWS=3
AGENT_TIMEOUT_MS=1200000
```

The initial provider adapter uses **OpenAI-compatible Chat Completions**, via
`@ai-sdk/openai-compatible`; the provider must support tool calling. This does not
require using OpenAI as the provider. Native provider protocols can be added at
the model factory boundary. No real provider credentials were used during MVP
initial implementation. Subsequent live testing with MiniMax-M3 verified actual
tool calls, filename repair, ComfyUI image-copy execution, output retrieval and
version saving. Leaving model, base URL or key unset permits session/version
management, reports `providerReady:false`, and rejects model tasks with HTTP 503.
Keys remain in the Gateway environment and are not returned to the App.

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
user. There is no attachment uploader inside the agent chat yet.

Z-Image defaults to 1024 square (hires: 2048×1152), 8 steps, CFG 1. H3 defaults to
864×480, 22 frames at 24fps (about 0.92s), with the reviewed LoRA/scheduler. Longer
clips increase memory and runtime; these defaults are smoke previews, not a
quality recommendation. Model weights are neither installed nor downloaded by
the agent. H3 video results contain audio; the App also supports standalone audio
outputs from imported supported workflows.

The language model receives text, schemas and execution diagnostics, **not output
pixels or media bytes**. Reference media goes to local ComfyUI execution. Image,
video and audio quality still requires user evaluation.

Use **one Gateway process per database**. The MVP uses short synchronous SQLite
transactions and one active model request at a time across sessions. GPU waits
are polled between model steps; a model request can delay polling by up to its
90-second timeout. API graphs and event pages are bounded, but automatic retention
and multi-process workers are not implemented. Back up the SQLite database using
a SQLite-aware backup or after stopping the Gateway (include WAL if copying live).

The existing Gateway is not an account system. Setup-token and browser logins
share one administrator workspace. Each registered native device has a distinct
workspace derived from its validated token; re-enrollment creates a new identity.
Sessions are not shared between browser and device identities. Anonymous Gateway
access does not authorize agent APIs. Reuse of the existing shared ComfyUI media
proxy is not a new multi-tenant media-isolation guarantee.

## API

All paths start with `/api/gateway/agent`; use existing cookie/device authentication.

| Method/path | Behavior |
| --- | --- |
| GET `/status` | Enabled/provider status and budgets, no secrets |
| GET/POST `/sessions` | List own sessions / create with optional canvas copy |
| GET `/sessions/:id?after=N` | Snapshot plus up to 200 events after cursor N |
| POST `/sessions/:id/messages` | `{requestId: UUID, message}`; idempotent request ID, one active task per session |
| POST `/sessions/:id/cancel` | `{taskId}` |
| GET `/sessions/:id/versions/:version` | Read immutable canvas/version |
| POST `/sessions/:id/save` | `{version}` |
| POST `/sessions/:id/restore` | `{version, baseVersion}`; create a new version when no task is active |

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
