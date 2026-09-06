# Cloud-first workflow synchronization

## Goal

ComfyUI's `user/default/workflows` directory is the source of truth. Every connected Comfy Mobile
client automatically sees the same workflows. IndexedDB remains a cache so the editor can open and
save while temporarily offline.

## Data model

- A cached workflow records its server filename, content ETag, server modification time, last sync
  time, dirty state, and the last synchronization error.
- New local workflows are uploaded automatically after connection.
- Existing server-imported local copies are adopted without creating duplicates.
- Deletes are written to a small durable outbox before the local cache entry is removed.

## Synchronization rules

1. On connection, foreground resume, local workflow change, and a 30-second interval, flush pending
   deletes and compare the server list with the local cache.
2. Upload new or dirty local workflows before pulling remote changes.
3. Use the last downloaded ETag as an optimistic concurrency precondition.
4. If two devices modify the same ETag, preserve the local edit as a conflict copy and pull the
   newer server version; never silently discard either copy.
5. Remove clean cached entries when their server file has been deleted.
6. When offline, retain cached workflows, dirty flags, and delete tombstones for the next reconnect.

## Server API changes

- Workflow list and content responses include a SHA-256 ETag.
- Save accepts `expected_etag` and returns HTTP 409 when the file changed.
- Delete accepts the same precondition and removes empty workflow subdirectories.
- Writes use an atomic temporary-file replacement.

## Verification

- Python path/security tests for the ComfyUI extension.
- Gateway route and unit tests.
- Production frontend and Android builds.
- Live public-Gateway tests for list, conflict-safe save, download, and delete.
- Android-emulator test proving workflows appear automatically without using the Import screen.

## Implementation and rollout status

Completed on 2026-09-05 as version 0.3.0:

- The ComfyUI extension and Gateway-hosted web app are deployed on `ai-server`.
- Public Gateway health, authentication, HTTP allowlist, WebSocket execution, image output, video
  output, and the complete conflict-safe workflow protocol pass against
  `https://comfy.zhvala.space:28443`.
- The Android debug app was installed and tested only on `emulator-5554`. Clearing the workflow
  object store repopulated 12 server workflows without visiting the Import screen.
- A workflow imported through the real Android UI was automatically uploaded, and deleting it on
  the server removed its clean offline cache entry on the next sync.
- The emulator remains enrolled and populated with the image and video manual-test workflows.

Useful repeatable checks:

```sh
npm run test:gateway
npm run test:e2e:cloud
npm run test:e2e:cloud:android
python3 comfy-mobile-ui-api-extension/tests/test_workflow_paths.py
```
