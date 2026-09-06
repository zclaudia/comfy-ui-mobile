# Gateway workflow foundation

Browser-independent TypeScript workflow library, now used by the Gateway agent,
its persistent task runner and the App assistant. See `../agent/README.md` for
configuration, deployment and end-to-end behavior. This module itself has no
external runtime dependencies. `npm run build:agent` compiles it with the agent;
the root `npm run gateway` command runs that build before starting the Gateway.

## API

- `validatePrompt(unknown, objectInfo)` returns structured diagnostics without network side effects.
- `applyPromptPatch(current, baseVersion, operations, objectInfo)` returns a new API graph/version after a complete batch validates. The input is unchanged on success and failure. Database callers must still compare-and-swap the stored version in a transaction.
- `canvasToPrompt(canvas, objectInfo)` converts supported core canvas nodes. Pass `false` as the third argument to inspect or repair invalid values; this only skips prompt semantics, not canvas structure checks.
- `promptToCanvas(original, prompt, objectInfo)` updates parameters and connections, preserves layout and unknown metadata, and verifies an input-value round trip.
- `applyCanvasPatch(current, baseVersion, operations, objectInfo)` returns both canvas and prompt only after both succeed. Use this boundary for future canvas-backed agent tools.
- `ComfyAdapter` reads node definitions, queue and history and explicitly submits validated prompts. Construct it from trusted Gateway configuration. `submit` consumes GPU resources; it never retries. A transport failure or ambiguous response sets `ComfyRequestError.outcomeUncertain`; reconcile the submission before any retry. Server validation errors remain available in `details`.

## Supported scope

The canvas codec supports flat ComfyUI 0.4 workflows in normal mode. Explicit
widget layouts cover classic checkpoint nodes plus the Z-Image/H3 nodes listed
in `coreWidgetLayouts` in `canvas.ts`. KSampler supports both legacy six-widget
arrays and arrays containing the UI-only seed control. Optional newer video
widgets may be absent. Note/MarkdownNote nodes are preserved without execution.

The validator supports schema-declared COMBO options, V3 dynamic-combo keys and
bounded typed V3 autogrow reference slots. It does not infer arbitrary custom
widgets. H3 shape constraints are checked in addition to installed node schemas.
Advanced SaveVideo encoding arrays are rejected rather than silently flattened.

API graphs support node addition/removal and setting/removing inputs. Existing
canvas editing only updates parameters/connections; template builders create new
canvases. Subgraphs, bypass and arbitrary topology edits remain unsupported. Link
IDs may be regenerated on export. Python node validation and visual quality still
require actual execution.

The agent layer supplies execution polling, recovery, version storage and task
ownership. There is no global interrupt operation. Submission metadata contains
task, attempt and version identifiers; this is not a deduplication guarantee.
Callers must ensure supplied canvas metadata belongs to the submitted prompt.

## Verification

Run from repository root:

```sh
node_modules/.bin/tsc -p gateway/workflow/tsconfig.json
node_modules/.bin/tsx --test gateway/workflow/test/*.test.ts
npm run test:gateway
```

Tests use the existing sample-workflow.json and a local mock ComfyUI HTTP server.
They do not call a model service or submit work to a real GPU server.
