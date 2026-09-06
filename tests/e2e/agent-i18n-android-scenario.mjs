/** Read-only UI regression; requires an enrolled emulator with at least one chat. */
export async function agentI18nAndroidScenario({ app, waitFor, assert, sleep, capture }) {
const original=await app.evaluate('localStorage.getItem("i18nextLng")');
const results=[];
try {
 for(const [lang,title,search] of [['en','Chats','Search chats'],['ja','チャット','チャットを検索'],['ko','대화','채팅 검색'],['zh','对话','搜索会话']]) {
   const searchSel=`input[aria-label="${search}"]`;
   await app.evaluate(`localStorage.setItem('i18nextLng',${JSON.stringify(lang)});location.href='/chats';true`).catch(()=>{});
   await waitFor(`document.querySelector('header span')?.textContent===${JSON.stringify(title)} && !!document.querySelector(${JSON.stringify(searchSel)})`);
   await waitFor(`document.querySelectorAll('[data-agent-session]').length>0`);
   const count=await app.evaluate(`document.querySelectorAll('[data-agent-session]').length`);
   await app.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(searchSel)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'__missing_session__');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
   await waitFor(`document.querySelectorAll('[data-agent-session]').length===0`);
   await app.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(searchSel)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
   await waitFor(`document.querySelectorAll('[data-agent-session]').length===${count}`);
   if (capture) await capture(lang);
   const id=await app.evaluate(`(()=>{const b=[...document.querySelectorAll('[data-agent-session]')].at(-1);const id=b.dataset.agentSession;b.click();return id})()`);
   await waitFor(`location.pathname===('/chat/'+${JSON.stringify(id)}) && document.querySelectorAll('[data-agent-turn]').length>0`);
   const noOverflow=await app.evaluate(`document.documentElement.scrollWidth<=innerWidth`);
   assert(noOverflow,'chat page must not overflow horizontally after switching sessions');
   results.push({lang,count,search:true,switched:true,headerVisible:true});
 }
} finally {
 await app.evaluate(`${original===null?"localStorage.removeItem('i18nextLng')":`localStorage.setItem('i18nextLng',${JSON.stringify(original)})`};location.href='/chats';true`).catch(()=>{});
}

return results;
}
