import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import sharp from 'sharp';
import { MockLanguageModelV3 } from 'ai/test';
import { AgentService } from '../service.js';
import { activeStates } from '../store.js';
import { WorkspaceComfy, mediaKey } from './workspaceFixture.js';
import type { RequestContext } from '../workspace/types.js';
import { workspaceTools } from '../workspace/tools.js';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 10, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } };
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolName, toolCallId: randomUUID(), input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] });
const answer = () => ({ content: [{ type: 'text' as const, text: '本次生成已完成。' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] });

test('capability inspection distinguishes installed nodes from the editable workspace subset', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-capabilities-'));
  const adapter = new WorkspaceComfy();
  adapter.info.InstalledButUneditable = structuredClone(adapter.info.LoadImage);
  const service = new AgentService({ agentStorePath: join(directory, 'agent.sqlite'), comfyUrl: 'http://unused.invalid',
    agentWorkspace: { directory: join(directory, 'media'), serverId: 'server' } }, { adapter, model: new MockLanguageModelV3() });
  try {
    const session = await service.createSession('owner', 'capabilities');
    const task = service.enqueue(session.id, 'owner', randomUUID(), '检查局部重绘能力');
    task.state = 'running'; service.store.update(task);
    const tools = workspaceTools(service.workspace!, task, adapter.info, new AbortController().signal);
    const result = await tools.inspect_environment.execute!({}, { toolCallId: 'inspect', messages: [] }) as { editableNodeTypes: string[]; installedNodeTypeCount: number; scope: string };
    assert.equal(result.installedNodeTypeCount, Object.keys(adapter.info).length);
    assert.ok(result.editableNodeTypes.includes('LoadImage'));
    assert.ok(!result.editableNodeTypes.includes('InstalledButUneditable'));
    assert.match(result.scope, /unsupported here does not mean uninstalled/);
    assert.deepEqual(await tools.get_node_schema.execute!({ name: 'InstalledButUneditable' }, { toolCallId: 'schema', messages: [] }), { name: 'InstalledButUneditable', installed: true, workspaceEditable: false, schema: adapter.info.InstalledButUneditable });
    assert.ok(adapter.info.KSampler);
    assert.deepEqual(await tools.get_node_schema.execute!({ name: 'KSampler' }, { toolCallId: 'sampler', messages: [] }), { name: 'KSampler', installed: true, workspaceEditable: true, schema: adapter.info.KSampler });
    assert.deepEqual(await tools.get_node_schema.execute!({ name: 'MissingNode' }, { toolCallId: 'missing', messages: [] }), { name: 'MissingNode', installed: false, workspaceEditable: false, error: '节点未安装' });
    assert.equal(adapter.submits, 0);
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('selected videos do not consume image-token headroom or prevent metadata-only requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-video-context-'));
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    calls++;
    assert.equal(JSON.stringify(options.prompt).includes('"type":"image"'), false);
    return call('finish_response', { answer: '已找到所选的四段视频，没有生成新内容。' });
  } });
  const adapter = new WorkspaceComfy();
  const service = new AgentService({ agentStorePath: join(directory, 'agent.sqlite'), comfyUrl: 'http://unused.invalid', agentContextWindow: 32768,
    agentWorkspace: { directory: join(directory, 'media'), serverId: 'server' } }, { model, adapter });
  try {
    const session = await service.createSession('owner', 'video references');
    const assets = [];
    for (let index = 0; index < 4; index++) {
      const ref = { filename: `selected-${index}.mp4`, subfolder: '', type: 'input' as const };
      adapter.files.set(mediaKey(ref), Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom0000isommp42')]));
      const asset = service.workspace!.assets.registerUpload(session.id, { ...ref, kind: 'video' }, randomUUID());
      await service.workspace!.assets.read(session.id, asset.id); assets.push(asset.id);
    }
    const task = service.enqueue(session.id, 'owner', randomUUID(), '列出所选的四段视频，不要生成。', { selectedAssetIds: assets });
    for (let i = 0; i < 4 && activeStates.includes(service.store.task(task.id).state); i++) await service.tick();
    assert.equal(service.store.task(task.id).state, 'completed');
    assert.equal(calls, 2, 'ordinary completion and its audit fit without needless compaction');
    assert.equal(adapter.submits, 0);
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('Agent scheduler completes image → video → edit original image → update video using independent drafts and durable assets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-runtime-'));
  const script: (() => ReturnType<typeof call> | ReturnType<typeof answer>)[] = [];
  let modelCalls = 0;
  let summaryCalls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    if (options.prompt.some(message => message.role === 'system' && message.content.includes('Maintain a concise conversation memory'))) {
      summaryCalls++;
      return { ...answer(), content: [{ type: 'text' as const, text: '已经完成的生成无需重复；继续当前用户请求。具体草稿和素材从持久化状态读取。' }] };
    }
    modelCalls++;
    assert.ok(options.prompt.some(message => message.role === 'system' && message.content.includes('independent Drafts')));
    const fn = script.shift(); assert.ok(fn, 'unexpected model continuation'); return fn();
  } });
  const adapter = new WorkspaceComfy(); adapter.complete = true;
  const imageRef = { filename: 'image.png', subfolder: '', type: 'output' };
  adapter.files.set(mediaKey(imageRef), await sharp({ create: { width: 64, height: 96, channels: 3, background: 'red' } }).png().toBuffer());
  adapter.files.set(mediaKey({ ...imageRef, filename: 'video.mp4' }), Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom0000isommp42')]));
  const service = new AgentService({ agentStorePath: join(directory, 'agent.sqlite'), comfyUrl: 'http://unused.invalid', agentContextWindow: 32768,
    agentWorkspace: { directory: join(directory, 'media'), serverId: 'server' } }, { model, adapter });
  try {
    const session = await service.createSession('owner', 'cat movie');
    const runtime = service.workspace!; const repo = runtime.repository;
    const operation = (key: string) => repo.operations(session.id, service.store.tasks(session.id)[0].id).find(op => op.stepKey === key)!.id;
    const finish = () => script.push(answer, () => call('finish_response', { answer: '本次生成已完成。' }));
    const execute = async (text: string, context: RequestContext = {}) => {
      const task = service.enqueue(session.id, 'owner', randomUUID(), text, context);
      for (let i = 0; i < 20 && activeStates.includes(service.store.task(task.id).state); i++) await service.tick();
      const latest = service.store.task(task.id);
      assert.equal(latest.state, 'completed', JSON.stringify({ error: latest.error, events: service.store.events(session.id).slice(-6) }));
      assert.equal(script.length, 0);
      return latest;
    };
    script.push(
      () => call('plan_operations', { steps: [{ stepKey: 'image', kind: 'create_workflow' }] }),
      () => call('create_workflow', { operationId: operation('image'), templateId: 'z-image-turbo', name: '猫咪图片', text: 'cat' }),
      () => call('plan_operations', { steps: [{ stepKey: 'render', kind: 'submit_preview', targetDraftId: repo.drafts(session.id).items[0].id, dependsOn: ['image'] }] }),
      () => call('submit_preview', { operationId: operation('render'), draftId: repo.drafts(session.id).items[0].id, revision: 1 }),
    ); finish();
    const first = await execute('生成一张猫的图片');
    assert.equal(first.previews, 1);
    const a = repo.drafts(session.id).items[0]; const i1 = repo.assets(session.id, { kind: 'image' }).items[0];
    assert.equal(i1.captureState, 'ready');
    script.push(
      () => call('get_asset', { assetId: i1.id }),
      () => call('plan_operations', { steps: [{ stepKey: 'video', kind: 'create_workflow' }] }),
      () => call('create_workflow', { operationId: operation('video'), templateId: 'h3-ref-image', name: '挥手视频', text: 'cat waves', seed: 77, references: [{ nodeId: '17', inputName: 'image', assetId: i1.id }] }),
      () => call('plan_operations', { steps: [{ stepKey: 'render', kind: 'submit_preview', targetDraftId: repo.drafts(session.id).items[0].id, dependsOn: ['video'] }] }),
      () => call('submit_preview', { operationId: operation('render'), draftId: repo.drafts(session.id).items[0].id, revision: 1 }),
    ); finish();
    await execute('用这张图生成挥手视频', { selectedAssetIds: [i1.id], action: 'generate_video' });
    const b = repo.drafts(session.id).items[0];
    const oldVideo = repo.runs(session.id, { draftId: b.id }).items[0];
    assert.equal(oldVideo.inputManifest[0].assetId, i1.id);
    adapter.files.set(mediaKey(imageRef), await sharp({ create: { width: 64, height: 96, channels: 3, background: 'blue' } }).png().toBuffer());
    script.push(
      () => call('get_workflow', { draftId: a.id, revision: 1 }),
      () => call('plan_operations', { steps: [{ stepKey: 'edit', kind: 'edit_workflow', targetDraftId: a.id }] }),
      () => call('edit_workflow', { operationId: operation('edit'), draftId: a.id, sourceRevision: 1, expectedHeadRevision: 1, summary: '海边背景', operations: [{ op: 'set_input', nodeId: '5', input: 'text', value: 'cat on beach' }] }),
      () => call('plan_operations', { steps: [{ stepKey: 'render', kind: 'submit_preview', targetDraftId: a.id, dependsOn: ['edit'] }] }),
      () => call('submit_preview', { operationId: operation('render'), draftId: a.id, revision: 2 }),
    ); finish();
    await execute('回头把图片背景改成海边，再生成图片', { targetDraftId: a.id, sourceRevision: 1, selectedAssetIds: [i1.id], action: 'edit_source' });
    assert.equal(adapter.submits, 3, 'editing the image does not regenerate video');
    assert.equal(repo.draft(session.id, b.id).headRevision, 1);
    assert.deepEqual(repo.run(session.id, oldVideo.id), oldVideo);
    const i2 = repo.assets(session.id, { kind: 'image' }).items[0];
    assert.notEqual(i2.id, i1.id); assert.notEqual(i2.blobDigest, i1.blobDigest);
    script.push(
      () => call('get_workflow', { draftId: b.id, revision: 1 }),
      () => call('plan_operations', { steps: [{ stepKey: 'edit', kind: 'edit_workflow', targetDraftId: b.id }] }),
      () => call('edit_workflow', { operationId: operation('edit'), draftId: b.id, sourceRevision: 1, expectedHeadRevision: 1, summary: '使用新图片', bindingChanges: [{ nodeId: '17', inputName: 'image', assetId: i2.id }] }),
      () => call('plan_operations', { steps: [{ stepKey: 'render', kind: 'submit_preview', targetDraftId: b.id, dependsOn: ['edit'] }] }),
      () => call('submit_preview', { operationId: operation('render'), draftId: b.id, revision: 2 }),
    ); finish();
    await execute('用新图片更新刚才的视频，动作不变', { targetDraftId: b.id, sourceRevision: 1, selectedAssetIds: [i2.id] });
    assert.equal(adapter.submits, 4);
    assert.equal(repo.drafts(session.id).items.length, 2);
    assert.equal(repo.draft(session.id, a.id).headRevision, 2); assert.equal(repo.draft(session.id, b.id).headRevision, 2);
    const newVideo = repo.runs(session.id, { draftId: b.id }).items[0];
    assert.equal(newVideo.inputManifest[0].assetId, i2.id);
    assert.equal(repo.run(session.id, oldVideo.id).inputManifest[0].assetId, i1.id);
    const provenance = runtime.assetProvenance(session.id, oldVideo.outputAssetIds[0]);
    assert.deepEqual(provenance.source, { runId: oldVideo.id, draftId: b.id, revision: 1, currentHeadRevision: 2, incomplete: false });
    assert.deepEqual(provenance.inputs[0].source, { runId: i1.sourceRunId, draftId: a.id, revision: 1, currentHeadRevision: 2, incomplete: false });
    assert.equal(provenance.inputs[0].assetId, i1.id);
    const followup = service.enqueue(session.id, 'owner', randomUUID(), '改这段旧视频当时使用的原图', { targetDraftId: b.id, sourceRevision: 1, selectedAssetIds: oldVideo.outputAssetIds });
    // This evidence comes from immutable Runs, not the latest image head or summarized history.
    followup.messages = [];
    assert.deepEqual(runtime.state(followup).selectedAssetProvenance, [provenance]);
    const edit = (sourceRevision: number) => call('edit_workflow', { operationId: operation('historical-edit'), draftId: a.id, sourceRevision, expectedHeadRevision: 2, summary: 'forest', operations: [{ op: 'set_input', nodeId: '5', input: 'text', value: 'cat in forest' }] });
    script.push(
      () => call('plan_operations', { steps: [{ stepKey: 'historical-edit', kind: 'edit_workflow', targetDraftId: a.id }] }),
      () => edit(2),
      () => {
        assert.equal(repo.draft(session.id, a.id).headRevision, 2, 'wrong historical base is rejected before any write');
        assert.equal(repo.operations(session.id, followup.id)[0].state, 'planned', 'rejected source check did not consume the operation');
        return call('get_workflow', { draftId: a.id, revision: 1 });
      },
      () => edit(1),
      () => call('finish_response', { answer: '原图提示词已修改，没有生成。' }),
      () => call('finish_response', { answer: '原图提示词已修改，没有生成。' }),
    );
    for (let i = 0; i < 12 && activeStates.includes(service.store.task(followup.id).state); i++) await service.tick();
    assert.equal(service.store.task(followup.id).state, 'completed'); assert.equal(script.length, 0);
    assert.equal(repo.revision(session.id, a.id, 3).sourceRevision, 1);
    assert.equal(repo.revision(session.id, a.id, 3).previousHeadRevision, 2);
    assert.doesNotThrow(() => runtime.assertHistoricalInputBase(followup.id, a.id, 3), 'this task can continue its own historical edit');
    assert.throws(() => runtime.assertHistoricalInputBase(followup.id, a.id, 2), /历史基础/);
    assert.equal(adapter.submits, 4);
    const explicit = service.enqueue(session.id, 'owner', randomUUID(), '修改图片当前版本', { targetDraftId: a.id, sourceRevision: 3, selectedAssetIds: oldVideo.outputAssetIds });
    assert.doesNotThrow(() => runtime.assertHistoricalInputBase(explicit.id, a.id, 3));
    service.cancel(session.id, 'owner', explicit.id);
    const choose = service.enqueue(session.id, 'owner', randomUUID(), '选择另一图片版本', { targetDraftId: b.id, selectedAssetIds: oldVideo.outputAssetIds });
    choose.state = 'running'; service.store.update(choose);
    const question = runtime.selections.request(session.id, choose.id, { requestId: 'choose-version', question: '选择图片版本', candidates: [{ type: 'draft', draftId: a.id, revision: 2 }] });
    assert.throws(() => runtime.assertHistoricalInputBase(choose.id, a.id, 2), /历史基础/);
    runtime.selections.answer(session.id, choose.id, question.id, { selectedIndices: [0] });
    assert.doesNotThrow(() => runtime.assertHistoricalInputBase(choose.id, a.id, 2));
    service.cancel(session.id, 'owner', choose.id);
    const oldPrompt = structuredClone(oldVideo.executionSnapshot!.prompt); const newPrompt = structuredClone(newVideo.executionSnapshot!.prompt);
    for (const prompt of [oldPrompt, newPrompt]) for (const node of Object.values(prompt)) {
      if (node.class_type === 'LoadImage') node.inputs.image = 'reference';
      if ('filename_prefix' in node.inputs) node.inputs.filename_prefix = 'isolated-output-prefix';
    }
    assert.deepEqual(newPrompt, oldPrompt, 'video motion and sampling parameters remain identical');
    assert.equal(service.store.session(session.id).version, 0, 'new runtime never writes a global workflow version');
    assert.ok(modelCalls > 20);
    assert.ok(summaryCalls > 0, 'the four-turn chain also survives context compression within the default window');
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('Agent resumes an approved persisted Run after restart without another model call or duplicate submission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-approval-runtime-'));
  const adapter = new WorkspaceComfy(); adapter.complete = true;
  const config = { agentStorePath: join(directory, 'agent.sqlite'), comfyUrl: 'http://unused.invalid', agentContextWindow: 65536, agentWorkspace: { directory: join(directory, 'media'), serverId: 'server' } };
  let service: AgentService;
  let sessionId = ''; let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => {
    calls++;
    const repo = service.workspace!.repository;
    const task = service.store.tasks(sessionId)[0];
    if (calls === 1) return call('plan_operations', { steps: [{ stepKey: 'create', kind: 'create_workflow' }] });
    if (calls === 2) return call('create_workflow', { operationId: repo.operations(sessionId, task.id)[0].id, templateId: 'z-image-turbo', name: 'cat', text: 'cat' });
    if (calls === 3) return call('plan_operations', { steps: [{ stepKey: 'run', kind: 'submit_preview', targetDraftId: repo.drafts(sessionId).items[0].id }] });
    if (calls === 4) return call('submit_preview', { operationId: repo.operations(sessionId, task.id)[1].id, draftId: repo.drafts(sessionId).items[0].id, revision: 1 });
    if (calls === 5) return answer();
    return call('finish_response', { answer: '生成完成。' });
  } });
  service = new AgentService(config, { adapter, model });
  try {
    sessionId = (await service.createSession('owner', 'confirmation')).id;
    service.workspace!.repository.updateSession(sessionId, { previewPolicy: 'confirm' });
    const task = service.enqueue(sessionId, 'owner', randomUUID(), '生成猫图片');
    for (let i = 0; i < 4; i++) await service.tick();
    assert.equal(service.store.task(task.id).state, 'waiting_user'); assert.equal(adapter.submits, 0);
    const pending = service.workspace!.repository.runs(sessionId).items[0];
    service.workspace!.approve(sessionId, task.id, pending.id, pending.approvalDigest!, true);
    await service.stop();
    service = new AgentService(config, { adapter, model });
    await service.tick();
    assert.equal(adapter.submits, 1); assert.equal(calls, 4, 'approval dispatch bypasses the language model');
    for (let i = 0; i < 5 && activeStates.includes(service.store.task(task.id).state); i++) await service.tick();
    assert.equal(service.store.task(task.id).state, 'completed');
    const run = service.workspace!.repository.run(sessionId, pending.id);
    assert.equal(run.state, 'succeeded'); assert.equal(run.approvalDigest, pending.approvalDigest); assert.equal(adapter.submits, 1);
    assert.equal(run.outputAssetIds.length, 1, 'missing output capture does not erase GPU success');
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('continuing after video failure and restart reuses the successful image and fixed video revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-partial-restart-'));
  class FailingVideoComfy extends WorkspaceComfy {
    failVideo = true;
    override async submit(...args: Parameters<WorkspaceComfy['submit']>) {
      const result = await super.submit(...args);
      const entry = this.history[result.promptId];
      if (this.failVideo && Object.values(entry.prompt[2]).some(node => node.class_type === 'MiniMaxH3ReferenceToVideo')) {
        entry.status = { completed: true, status_str: 'error' }; entry.outputs = {};
      }
      return result;
    }
  }
  const adapter = new FailingVideoComfy(); adapter.complete = true;
  adapter.files.set(mediaKey({ filename: 'image.png', subfolder: '', type: 'output' }), await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).png().toBuffer());
  adapter.files.set(mediaKey({ filename: 'video.mp4', subfolder: '', type: 'output' }), Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom0000isommp42')]));
  const config = { agentStorePath: join(directory, 'agent.sqlite'), comfyUrl: 'http://unused.invalid', agentContextWindow: 65536, agentWorkspace: { directory: join(directory, 'media'), serverId: 'server' } };
  const script: (() => ReturnType<typeof call>)[] = [];
  const model = new MockLanguageModelV3({ doGenerate: async () => {
    const next = script.shift(); assert.ok(next, 'unexpected model action'); return next();
  } });
  let service = new AgentService(config, { adapter, model });
  const settle = async (taskId: string) => {
    for (let i = 0; i < 12 && activeStates.includes(service.store.task(taskId).state); i++) await service.tick();
    return service.store.task(taskId);
  };
  try {
    const session = await service.createSession('owner', 'partial movie');
    let runtime = service.workspace!;
    const image = runtime.workflows.create(session.id, { templateId: 'z-image-turbo', name: 'cat', text: 'cat' }, { requestId: randomUUID() }, adapter.info);
    const imageTask = runtime.enqueueRun(session.id, randomUUID(), image.draft.id, 1, 60000);
    assert.equal((await settle(imageTask.id)).state, 'completed');
    const imageRun = runtime.repository.runs(session.id).items[0];
    const assetId = imageRun.outputAssetIds[0];
    const video = runtime.workflows.create(session.id, { templateId: 'h3-ref-image', name: 'cat video', text: 'cat waves', references: [{ nodeId: '17', inputName: 'image', assetId }] }, { requestId: randomUUID() }, adapter.info);
    const videoTask = runtime.enqueueRun(session.id, randomUUID(), video.draft.id, 1, 60000);
    assert.equal((await settle(videoTask.id)).state, 'failed');
    const failedVideo = runtime.repository.runs(session.id, { draftId: video.draft.id }).items[0];
    assert.equal(failedVideo.state, 'failed'); assert.equal(failedVideo.inputManifest[0].assetId, assetId);
    assert.equal(adapter.submits, 2);
    await service.stop(); adapter.failVideo = false;
    service = new AgentService(config, { adapter, model }); runtime = service.workspace!;
    const task = service.enqueue(session.id, 'owner', randomUUID(), '继续完成刚才失败的视频');
    script.push(
      () => call('get_run', { runId: failedVideo.id }),
      () => call('get_asset', { assetId }),
      () => call('plan_operations', { steps: [{ stepKey: 'continue-video', kind: 'submit_preview', targetDraftId: video.draft.id }] }),
      () => call('submit_preview', { operationId: runtime.repository.operations(session.id, task.id)[0].id, draftId: video.draft.id, revision: 1 }),
      () => call('finish_response', { answer: '视频已完成，沿用原图片。' }),
      () => call('finish_response', { answer: '视频已完成，沿用原图片。' }),
    );
    assert.equal((await settle(task.id)).state, 'completed'); assert.equal(script.length, 0);
    const completedVideo = runtime.repository.runs(session.id, { draftId: video.draft.id }).items[0];
    assert.equal(completedVideo.state, 'succeeded'); assert.notEqual(completedVideo.id, failedVideo.id);
    assert.equal(completedVideo.revision, 1);
    assert.deepEqual(completedVideo.inputManifest, failedVideo.inputManifest);
    assert.deepEqual(runtime.repository.run(session.id, imageRun.id), imageRun);
    assert.deepEqual(runtime.repository.run(session.id, failedVideo.id), failedVideo);
    assert.equal(runtime.repository.drafts(session.id).items.length, 2);
    assert.equal(runtime.repository.runs(session.id).items.length, 3);
    assert.equal(runtime.repository.draft(session.id, video.draft.id).headRevision, 1);
    assert.equal(adapter.submits, 3, 'only the failed video receives a new submission');
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('Agent selection answer resumes the original task after restart and cancellation does not restart its model loop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-selection-runtime-'));
  const adapter = new WorkspaceComfy();
  const config = { agentStorePath: join(directory, 'agent.sqlite'), comfyUrl: 'http://unused.invalid', agentContextWindow: 65536, agentWorkspace: { directory: join(directory, 'media'), serverId: 'server' } };
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    calls++;
    if (calls === 1) return call('request_selection', { requestId: 'choose', question: '请说明要调整的图片', candidates: [] });
    assert.match(JSON.stringify(options.prompt), /只讨论海边背景/);
    return calls === 2 ? answer() : call('finish_response', { answer: '可以将背景设为海边。' });
  } });
  let service = new AgentService(config, { adapter, model });
  try {
    const session = await service.createSession('owner', 'clarification');
    const task = service.enqueue(session.id, 'owner', randomUUID(), '调整图片');
    await service.tick();
    const waiting = service.store.task(task.id).workspace!.waitingReason!; assert.equal(waiting.type, 'selection');
    if (waiting.type !== 'selection') throw new Error('wrong waiting reason');
    await service.stop(); service = new AgentService(config, { adapter, model });
    service.workspace!.selections.answer(session.id, task.id, waiting.questionId, { selectedIndices: [], answer: '只讨论海边背景，不生成' });
    for (let i = 0; i < 4 && activeStates.includes(service.store.task(task.id).state); i++) await service.tick();
    assert.equal(service.store.task(task.id).state, 'completed'); assert.equal(adapter.submits, 0);
    const second = service.enqueue(session.id, 'owner', randomUUID(), '取消此次请求');
    service.cancel(session.id, 'owner', second.id); await service.tick();
    assert.equal(calls, 3); assert.equal(service.store.task(second.id).state, 'cancelled');
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('workspace models can finish through a tool without filler reads and still receive completion review', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-finish-runtime-'));
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    calls++;
    assert.ok(options.tools?.some(tool => tool.type === 'function' && tool.name === 'finish_response'));
    assert.equal(options.toolChoice?.type, calls === 1 ? 'auto' : 'required');
    return call('finish_response', { answer: calls === 1 ? '先给出的回答' : '核对后的最终说明，不需要生成。' });
  } });
  const adapter = new WorkspaceComfy();
  const service = new AgentService({ agentStorePath: join(directory, 'agent.sqlite'), comfyUrl: 'http://unused.invalid', agentContextWindow: 65536,
    agentWorkspace: { directory: join(directory, 'media'), serverId: 'server' } }, { model, adapter });
  try {
    const session = await service.createSession('owner', 'finish tool');
    const task = service.enqueue(session.id, 'owner', randomUUID(), '只解释创作流程，不修改或生成');
    await service.tick();
    assert.equal(service.store.task(task.id).state, 'queued');
    assert.equal(service.store.task(task.id).awaitingCompletion, true);
    assert.equal(service.store.events(session.id).filter(event => event.kind === 'assistant').length, 0, 'unreviewed answer is not published');
    await service.tick();
    assert.equal(service.store.task(task.id).state, 'completed'); assert.equal(calls, 2); assert.equal(adapter.submits, 0);
    assert.equal(service.store.events(session.id).filter(event => event.kind === 'assistant').length, 1);
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});
