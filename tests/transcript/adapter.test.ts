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
