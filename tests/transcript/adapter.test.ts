import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../../src/components/agent/transcript/adapter';
import type { AgentEvent } from '../../src/infrastructure/api/AgentApi';
const e = (seq: number, kind: string, data: Record<string, unknown> = {}, taskId: string | null = 't'): AgentEvent => ({ seq, kind, data, taskId, created: seq });
test('orders media inside a turn, deduplicates replay, keeps paragraph boundaries', () => {
 const rows = [e(1,'user',{text:'生成'}),e(3,'assistant',{text:'第一段'}),e(7,'result',{outputs:[]}),e(9,'assistant',{text:'第二段'}),e(12,'state',{state:'completed'})];
 const s = buildTranscript([...rows, ...rows].reverse());
 assert.equal(s.items.length,2);
 const turn = s.items[1];assert(turn.kind==='assistant_turn');
 assert.deepEqual(turn.blocks.map(b=>b.kind),['text','custom','text']);
 assert.equal(turn.status,'complete');
 assert.equal(turn.blocks[0].kind==='text' && turn.blocks[0].text,'第一段\n\n');
});
test('new and legacy tools only display once; submit success is not turn completion', () => {
 const s=buildTranscript([e(1,'tool_started',{name:'submit_preview',callId:'c'}),e(2,'tool',{name:'submit_preview',callId:'c'}),e(3,'tool_finished',{callId:'c',name:'submit_preview'}),e(4,'state',{state:'waiting_comfy'})]);
 const t=s.items[0];assert(t.kind==='assistant_turn');assert.equal(t.blocks.length,1);assert.equal(t.status,'streaming');assert.equal(t.toolCalls.c.status,'success');
});
test('task snapshot only reconciles after pagination; cancellation ends running tools', () => {
 const rows=[e(1,'tool_started',{callId:'c',name:'validate_workflow'})];
 const tasks=[{id:'t',state:'cancelled',message:'test'}];
 const partial=buildTranscript(rows,tasks,false).items[0];assert(partial.kind==='assistant_turn');assert.equal(partial.status,'streaming');
 const done=buildTranscript(rows,tasks,true).items[0];assert(done.kind==='assistant_turn');assert.equal(done.status,'cancelled');assert.equal(done.toolCalls.c.status,'cancelled');
});
test('independent saves stay top-level; old tools and errors remain readable', () => {
 const s=buildTranscript([e(1,'saved',{version:1},null),e(5,'tool',{name:'validate_workflow',result:{error:'bad'}}),e(8,'state',{state:'failed',error:'invalid'})]);
 assert.equal(s.items[0].kind,'marker');const t=s.items[1];assert(t.kind==='assistant_turn');assert.equal(t.toolCalls['event:5'].status,'error');assert.equal(t.error,'invalid');
});
test('a recovered terminal turn does not leave an orphaned read tool spinning', () => {
 const s=buildTranscript([e(1,'tool_started',{callId:'orphan',name:'inspect_environment'}),e(8,'state',{state:'completed'})]);
 const t=s.items[0];assert(t.kind==='assistant_turn');assert.equal(t.status,'complete');assert.equal(t.toolCalls.orphan.status,'cancelled');
});
test('multi-page replay with noncontiguous global sequences matches a single replay', () => {
 const rows: AgentEvent[]=[];
 for(let i=0;i<240;i++){ rows.push(e(i*10+1,'user',{text:`request ${i}`},`task-${i}`),e(i*10+3,'assistant',{text:`answer ${i}`},`task-${i}`),e(i*10+7,'state',{state:'completed'},`task-${i}`)); }
 const collected: AgentEvent[]=[];
 for(let i=0;i<rows.length;i+=200){collected.push(...rows.slice(i,i+200));const partial=buildTranscript(collected);assert.equal(partial.items.filter(t=>t.kind==='user_message').length,Math.ceil(collected.length/3));}
 assert.deepEqual(buildTranscript([...collected,...rows.slice(0,200)]),buildTranscript(rows));
});
test('a mutation keeps its arguments and result behind the card; a read-only call records nothing to expand', () => {
 const saved=buildTranscript([e(1,'tool_started',{callId:'c',name:'save_workflow_version'}),e(2,'tool',{callId:'c',name:'save_workflow_version',args:{version:2},result:{saved:true,version:2}}),e(3,'tool_finished',{callId:'c',name:'save_workflow_version',isError:false})]);
 const turn=saved.items[0];assert(turn.kind==='assistant_turn');
 assert.equal(turn.blocks.length,1);
 assert.deepEqual(turn.toolCalls.c.input,{version:2});
 assert.deepEqual(turn.toolCalls.c.result,{saved:true,version:2});
 const read=buildTranscript([e(1,'tool_started',{callId:'c',name:'inspect_environment'}),e(2,'tool_finished',{callId:'c',name:'inspect_environment',isError:false})]);
 const plain=read.items[0];assert(plain.kind==='assistant_turn');
 assert.equal(plain.toolCalls.c.input,undefined);
 assert.equal(plain.toolCalls.c.result,undefined);
});
test('diagnostics remain the expanded body when the tool recorded no result', () => {
 const s=buildTranscript([e(1,'tool_started',{callId:'c',name:'apply_workflow_patch'}),e(2,'tool_finished',{callId:'c',name:'apply_workflow_patch',isError:true,diagnostics:[{code:'x',message:'bad link'}],errorMessage:'工具 apply_workflow_patch 未完成，请查看诊断或助手说明'})]);
 const t=s.items[0];assert(t.kind==='assistant_turn');
 assert.equal(t.toolCalls.c.status,'error');
 assert.deepEqual(t.toolCalls.c.result,{diagnostics:[{code:'x',message:'bad link'}]});
});
test('args and results ride the started/finished pair, so a no-argument read tool still expands', () => {
 const s=buildTranscript([e(1,'tool_started',{callId:'c',name:'get_workflow',args:{}}),e(2,'tool_finished',{callId:'c',name:'get_workflow',isError:false,result:{version:2,nodes:3}})]);
 const t=s.items[0];assert(t.kind==='assistant_turn');
 assert.deepEqual(t.toolCalls.c.input,{});
 assert.deepEqual(t.toolCalls.c.result,{version:2,nodes:3});
});
test('a truncated payload arrives as a string the card can still render', () => {
 const s=buildTranscript([e(1,'tool_started',{callId:'c',name:'create_from_template',args:'{"text":"aaa… [truncated]'}),e(2,'tool_finished',{callId:'c',name:'create_from_template',isError:false,result:'{"id":1… [truncated]'})]);
 const t=s.items[0];assert(t.kind==='assistant_turn');
 assert.equal(typeof t.toolCalls.c.input,'string');
 assert.equal(typeof t.toolCalls.c.result,'string');
});
test('held submissions and retries stay inside their turn as custom blocks', () => {
 const s=buildTranscript([e(1,'tool_started',{callId:'c',name:'submit_preview'}),e(2,'tool_finished',{callId:'c',name:'submit_preview',isError:false,result:{status:'awaiting_user',version:1}}),e(3,'approval',{callId:'c',version:1,status:'pending'}),e(4,'state',{state:'waiting_user'}),e(5,'retry',{attempt:1,maxAttempts:3,delayMs:5000})]);
 const t=s.items[0];assert(t.kind==='assistant_turn');
 assert.deepEqual(t.blocks.map(b=>b.kind),['tool_call','custom','custom']);
 assert.equal(t.status,'streaming');
 assert.equal(t.toolCalls.c.status,'success');
});
