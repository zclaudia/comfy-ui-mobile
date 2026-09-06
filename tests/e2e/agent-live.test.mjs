/** Real Gateway + configured LLM + ComfyUI. Explicit opt-in; only generated test assets. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
if (process.env.E2E_AGENT_LIVE !== '1') throw new Error('E2E_AGENT_LIVE=1 required');
const token = process.env.E2E_GATEWAY_TOKEN;
if (!token) throw new Error('E2E_GATEWAY_TOKEN required');
const url = process.env.E2E_GATEWAY_URL || 'https://comfy.zhvala.space:28443';
const base = '/api/gateway/agent';
const runId = randomUUID();
const directory = new URL(`../output/agent-cases/${runId}/`, import.meta.url);
const reports = [];
const created = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function request(path, body, auth = token) {
  return fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? {Authorization:`Bearer ${auth}`} : {}), ...(body === undefined ? {} : {'Content-Type':'application/json'}) }, ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(15000) });
}
async function json(path, body, status = 200) {
  const response = await request(base + path, body);
  assert.equal(response.status, status, `HTTP ${response.status} at ${path}`);
  return response.json();
}
async function create(canvas) {
  const {session} = await json('/sessions', {name:`ComfyMobileE2E-${runId}`, ...(canvas ? {canvas} : {})}, 201);
  created.push(session.id); return session.id;
}
const snapshot = id => json(`/sessions/${id}`);
const version = (id,n) => json(`/sessions/${id}/versions/${n}`);
const message = (id,text,requestId=randomUUID()) => json(`/sessions/${id}/messages`, {message:text,requestId}, 202);
async function finish(id, taskId) {
  const deadline=Date.now()+240000;
  while(Date.now()<deadline) {
    const snap=await snapshot(id); const task=snap.tasks.find(t=>t.id===taskId);
    if (['completed','failed','cancelled'].includes(task?.state)) {
      reports.push({id,taskId,snapshot:snap});
      assert.equal(task.state,'completed',`Task ended ${task.state}: ${task.error || ''}`);
      return snap;
    }
    await sleep(1500);
  }
  throw new Error('Agent task timeout');
}
const nodeValue=(v,type,index=0)=>v.canvas.nodes.find(n=>n.type===type).widgets_values[index];
const executions=snap=>snap.events.filter(e=>e.kind==='result');
const assistant=snap=>snap.events.filter(e=>e.kind==='assistant' && e.taskId===snap.tasks[0]?.id).map(e=>e.data.text).join('\n');
await mkdir(directory,{recursive:true});
await test('Agent real application cases', {timeout:1200000}, async t => {
  t.after(async()=>{
    for(const id of created) {
      const snap=await snapshot(id).catch(()=>null);
      for(const task of snap?.tasks || []) if(['queued','running','waiting_comfy','reconciling'].includes(task.state)) await json(`/sessions/${id}/cancel`,{taskId:task.id}).catch(()=>{});
    }
    await writeFile(new URL('report.json',directory),JSON.stringify({runId,created,reports},null,2));
    console.log(`Agent evidence: ${directory.pathname}`);
  });
  await t.test('unauthenticated requests rejected; configured provider ready',async()=>{
    for(const path of ['/status','/sessions']) assert.equal((await request(base+path,undefined,'')).status,401);
    const status=await json('/status'); assert.equal(status.providerReady,true); assert.equal(status.enabled,true);
    assert.ok(!JSON.stringify(status).includes(token));
  });
  const canvas=JSON.parse(await readFile(new URL('../samples/workflows/live-e2e-workflow.json',import.meta.url),'utf8'));
  const fixture=await sharp({create:{width:64,height:64,channels:3,background:'#945dbf'}}).png().toBuffer();
  const upload=new FormData(); upload.append('image',new Blob([fixture],{type:'image/png'}),`ComfyMobileE2E-agent-${runId}.png`);
  const uploadedResponse=await fetch(url+'/upload/image',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:upload});
  assert.equal(uploadedResponse.status,200); const uploaded=await uploadedResponse.json();
  const input=uploaded.subfolder?`${uploaded.subfolder}/${uploaded.name}`:uploaded.name;
  canvas.nodes.find(n=>n.type==='LoadImage').widgets_values[0]=input;
  const prefix=`ComfyMobileE2E/AgentCases/${runId}`;
  canvas.nodes.find(n=>n.type==='SaveImage').widgets_values[0]=prefix;
  let id;
  await t.test('imports independent v1 and rejects unsupported canvas structures',async()=>{
    id=await create(canvas); assert.deepEqual((await version(id,1)).canvas,canvas);
    for(const bad of [{...canvas,version:1},{...canvas,nodes:[{...canvas.nodes[0],mode:4}]},{...canvas,nodes:[{...canvas.nodes[0],type:'UnknownAgentE2ENode'}]}]) {
      const response=await request(base+'/sessions',{name:'ComfyMobileE2E-invalid',canvas:bad});
      assert.ok([400,422].includes(response.status));
    }
  });
  await t.test('explains workflow without modifying it or executing GPU work',async()=>{
    const task=await message(id,'用中文解释当前工作流里每个节点的作用。只解释，不修改、保存或运行。');
    const snap=await finish(id,task.taskId); assert.equal(snap.session.version,1); assert.equal(executions(snap).length,0);assert.equal(snap.tasks[0].previews,0);
    assert.match(assistant(snap),/LoadImage/); assert.match(assistant(snap),/SaveImage/);
  });
  await t.test('edits parameters and saves without preview; keeps original version immutable',async()=>{
    const task=await message(id,`仅把 SaveImage.filename_prefix 改为 ${prefix}/round2，校验并保存。不要执行预览。`);
    const snap=await finish(id,task.taskId); assert.equal(snap.session.version,2); assert.equal(executions(snap).length,0);assert.equal(snap.tasks[0].previews,0);
    assert.equal(nodeValue(await version(id,2),'SaveImage'),`${prefix}/round2`); assert.equal((await version(id,2)).saved,true);
    assert.deepEqual((await version(id,1)).canvas,canvas);
  });
  await t.test('follow-up preserves prior edits and performs exactly one successful preview',async()=>{
    const task=await message(id,'保留刚才改好的所有参数，现在实际预览一次，成功后保存当前版本。不要重复运行。');
    const snap=await finish(id,task.taskId); assert.equal(snap.session.version,2); assert.equal(executions(snap).length,1);
    const output=executions(snap)[0].data.outputs[0];
    const response=await request('/view?'+new URLSearchParams(output)); assert.equal(response.status,200);
    const metadata=await sharp(Buffer.from(await response.arrayBuffer())).metadata(); assert.equal(metadata.width,64);assert.equal(metadata.height,64);
    assert.equal(nodeValue(await version(id,2),'SaveImage'),`${prefix}/round2`);
  });
  await t.test('restore creates v3; stale restore conflicts and history remains unchanged',async()=>{
    assert.equal((await json(`/sessions/${id}/restore`,{version:1,baseVersion:2})).version,3);
    assert.deepEqual((await version(id,3)).canvas,canvas);
    assert.equal((await request(base+`/sessions/${id}/restore`,{version:2,baseVersion:2})).status,409);
    assert.equal(nodeValue(await version(id,2),'SaveImage'),`${prefix}/round2`);
    assert.equal((await request(base+`/sessions/${id}/versions/9999`)).status,404);
  });
  await t.test('invalid image diagnosis stays read-only; repair makes a valid saved version',async()=>{
    const broken=structuredClone(canvas); broken.nodes.find(n=>n.type==='LoadImage').widgets_values[0]='ComfyMobileE2E-does-not-exist.png';
    const brokenId=await create(broken);
    const diagnosis=await message(brokenId,'检查当前工作流并说明问题，只诊断，不修改，不运行。');
    const initial=await finish(brokenId,diagnosis.taskId);assert.equal(initial.session.version,1);assert.equal(executions(initial).length,0);assert.equal(initial.tasks[0].previews,0);
    assert.match(assistant(initial),/不存在|无效|未找到|找不到|不在|不可用|缺失/);
    const repair=await message(brokenId,`把 LoadImage.image 修复为 ${input}，校验并保存。不运行。`);
    const fixed=await finish(brokenId,repair.taskId);assert.equal(fixed.session.version,2);assert.equal(executions(fixed).length,0);assert.equal(fixed.tasks[0].previews,0);
    assert.equal(nodeValue(await version(brokenId,2),'LoadImage'),input);assert.equal((await version(brokenId,2)).saved,true);
  });
  await t.test('duplicate submission idempotency, concurrent-task protection and cancellation',async()=>{
    const requestId=randomUUID(); const text='检查当前工作流并逐个解释节点，不修改也不运行。';
    const first=await message(id,text,requestId);const duplicate=await message(id,text,requestId);assert.equal(duplicate.taskId,first.taskId);
    assert.equal((await request(base+`/sessions/${id}/messages`,{requestId,message:'different'})).status,409);
    assert.equal((await request(base+`/sessions/${id}/messages`,{requestId:randomUUID(),message:text})).status,409);
    assert.equal((await request(base+`/sessions/${id}/restore`,{version:1,baseVersion:3})).status,409);
    await json(`/sessions/${id}/cancel`,{taskId:first.taskId}); await json(`/sessions/${id}/cancel`,{taskId:first.taskId});
    const snap=await snapshot(id);assert.equal(snap.tasks.find(t=>t.id===first.taskId).state,'cancelled');
    assert.equal(snap.events.filter(e=>e.taskId===first.taskId&&e.kind==='user').length,1);
    const retry=await message(id,text,requestId);assert.equal(retry.taskId,first.taskId);
  });
  await t.test('can continue a cancelled session with a new message',async()=>{
    const task=await message(id,'简短说明当前 SaveImage 的 filename_prefix 值。不修改，不运行。');
    const snap=await finish(id,task.taskId);assert.ok(assistant(snap).includes(prefix));assert.equal(snap.session.version,3);
  });
  await t.test('invalid message, cursor and forged owner rejected without side effects',async()=>{
    const before=await snapshot(id);
    for(const body of [{requestId:randomUUID(),message:''},{requestId:'invalid',message:'x'},{requestId:randomUUID(),message:'x',owner:'other'},{requestId:randomUUID(),message:'x'.repeat(8001)}]) assert.equal((await request(base+`/sessions/${id}/messages`,body)).status,400);
    assert.equal((await request(base+`/sessions/${id}?after=-1`)).status,400);
    assert.equal((await snapshot(id)).tasks.length,before.tasks.length);
  });
  await t.test('event pagination and reconnect cursor do not lose or repeat events',async()=>{
    const pagesId=await create(canvas);
    for(let i=0;i<205;i++) await json(`/sessions/${pagesId}/save`,{version:1});
    const first=await snapshot(pagesId);assert.equal(first.events.length,200);assert.equal(first.hasMore,true);
    const second=await json(`/sessions/${pagesId}?after=${first.cursor}`);assert.equal(second.events.length,5);assert.equal(second.hasMore,false);
    assert.equal(new Set([...first.events,...second.events].map(e=>e.seq)).size,205);
    assert.equal((await json(`/sessions/${pagesId}?after=${second.cursor}`)).events.length,0);
  });
  await t.test('another device cannot read or mutate admin sessions',async()=>{
    const response=await request('/api/gateway/devices/register',{token,deviceName:`ComfyMobileE2E-Agent-${runId}`});assert.equal(response.status,201);
    const device=await response.json();
    try {
      const other=device.deviceToken;
      assert.ok(other);
      for(const [path,body] of [[`/sessions/${id}`],[`/sessions/${id}/versions/1`],[`/sessions/${id}/save`,{version:1}],[`/sessions/${id}/restore`,{version:1,baseVersion:3}],[`/sessions/${id}/messages`,{requestId:randomUUID(),message:'x'}],[`/sessions/${id}/cancel`,{taskId:(await snapshot(id)).tasks[0].id}]]) assert.equal((await request(base+path,body,other)).status,404);
      const list=await (await request(base+'/sessions',undefined,other)).json();assert.ok(!list.sessions.some(s=>s.id===id));
    } finally { assert.equal((await fetch(url+`/api/gateway/devices/${device.device.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}})).status,200); }
  });
  await t.test('empty session inspects actual environment and handles unavailable checkpoint',async()=>{
    const emptyId=await create();
    const task=await message(emptyId,'我想创建基础 checkpoint 文生图工作流。先查看环境和模板；若没有兼容的 checkpoint 请明确说明缺少什么，不要编造模型名。只创建不运行。');
    const snap=await finish(emptyId,task.taskId);assert.equal(executions(snap).length,0);assert.equal(snap.tasks[0].previews,0);
    const info=await (await request('/object_info/CheckpointLoaderSimple')).json();
    const checkpoints=info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    if(!checkpoints.length) {assert.equal(snap.session.version,0);assert.match(assistant(snap),/没有|未安装|未检测|缺少|缺失|为空|不可用/);} else {assert.ok(snap.session.version<=1);}
  });
});
