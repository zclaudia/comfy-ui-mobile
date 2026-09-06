/** Read-only UI regression; requires an enrolled emulator with at least one chat. */
export async function agentI18nAndroidScenario({ app, waitFor, assert, sleep, capture }) {
const original=await app.evaluate('localStorage.getItem("i18nextLng")');
const results=[];
try {
 for(const [lang,title,history,search] of [['en','Workflow assistant','Chat history','Search chats'],['ja','ワークフローアシスタント','チャット履歴','チャットを検索'],['ko','워크플로 어시스턴트','채팅 기록','채팅 검색'],['zh','工作流助手','历史会话','搜索会话']]) {
   await app.evaluate(`localStorage.setItem('i18nextLng',${JSON.stringify(lang)});location.href='/agent';true`).catch(()=>{});
   await waitFor(`document.querySelector('header h1')?.textContent===${JSON.stringify(title)} && !!document.querySelector('[data-agent-history]')`);
   await app.evaluate(`document.querySelector('[data-agent-history]').click();true`);
   await waitFor(`document.querySelector('[role=dialog]')?.textContent.includes(${JSON.stringify(history)}) && document.querySelectorAll('[data-agent-history-session]').length>0 && !document.querySelector('[role=dialog] .animate-spin')`);
   const count=await app.evaluate(`document.querySelectorAll('[data-agent-history-session]').length`);
   await app.evaluate(`(()=>{const e=document.querySelector('[role=dialog] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'__missing_session__');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
   await waitFor(`document.querySelectorAll('[data-agent-history-session]').length===0`);
   await app.evaluate(`(()=>{const e=document.querySelector('[role=dialog] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
   await waitFor(`document.querySelectorAll('[data-agent-history-session]').length===${count}`);
   if (capture) await capture(lang);
   const id=await app.evaluate(`(()=>{const b=[...document.querySelectorAll('[data-agent-history-session]')].at(-1);const id=b.dataset.agentHistorySession;b.click();return id})()`);
   await waitFor(`!document.querySelector('[role=dialog]') && document.querySelector('select')?.value===${JSON.stringify(id)} && document.querySelectorAll('[data-agent-turn]').length>0`);
   const visible=await app.evaluate(`(()=>{const r=document.querySelector('[data-agent-history]').getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight&&document.documentElement.scrollWidth<=innerWidth})()`);
   assert(visible,'fixed history button must remain on screen');
   results.push({lang,count,search:true,switched:true,headerVisible:true});
 }
} finally {
 await app.evaluate(`${original===null?"localStorage.removeItem('i18nextLng')":`localStorage.setItem('i18nextLng',${JSON.stringify(original)})`};location.href='/agent';true`).catch(()=>{});
}

return results;
}
