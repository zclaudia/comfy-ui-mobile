/** Run after the model scenario: retain media, summarize once, then exercise native copy/paste. */
export async function transcriptAndroidScenario({ app, waitFor, assert, adb, sleep }) {
  await app.evaluate('localStorage.setItem("i18nextLng","zh");location.href="/agent";true').catch(() => {});
  await waitFor(`!!document.querySelector('video') && !!document.querySelector('textarea:not(:disabled)')`,30000);
  const before=await app.evaluate(`document.querySelectorAll('[data-agent-turn]').length`);
  const message='请把刚才视频的尺寸、帧数、种子整理成 Markdown 表格，再用 json 代码块列出 width、height、frames、seed。只整理已有信息，不要再次生成。';
  await app.evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(message)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(200);
  await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').click();true`);
  await waitFor(`document.querySelectorAll('[data-agent-turn]').length>${before} && !document.querySelector('footer [role=status]') && !!document.querySelector('.ztk-code-block')`,180000);
  const result=await app.evaluate(`(()=>{const turn=[...document.querySelectorAll('[data-agent-turn]')].at(-1);const code=turn.querySelector('.ztk-code-block');code?.scrollIntoView({block:'center'});return {complete:turn.querySelector('[data-turn-status]')?.dataset.turnStatus==='complete',tables:turn.querySelectorAll('table').length,code:code?.querySelector('code').textContent,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert(result.complete && result.tables>0 && typeof result.code==='string' && !result.overflow);
  await sleep(500);
  const point=await app.evaluate(`(()=>{const b=[...document.querySelectorAll('.ztk-code-block__action')].at(-1);const r=b.getBoundingClientRect();return {x:Math.round((r.x+r.width/2)*devicePixelRatio),y:Math.round((r.y+r.height/2)*devicePixelRatio)}})()`);
  await adb('shell','input','tap',String(point.x),String(point.y));
  await waitFor(`[...document.querySelectorAll('.ztk-code-block__action')].at(-1)?.textContent==='已复制'`,10000);
  await app.evaluate(`document.querySelector('textarea').focus();true`);
  await adb('shell','input','keyevent','279');
  await sleep(300);
  assert.equal(await app.evaluate(`document.querySelector('textarea').value`),result.code);
  await app.evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));e.blur();return true})()`);
  return { ...result, copyPasteMatches:true };
}
