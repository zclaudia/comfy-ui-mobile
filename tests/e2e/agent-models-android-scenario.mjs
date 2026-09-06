/** Runs real LLM + GPU workflows through the installed Android app UI. */
export async function agentModelsAndroidScenario({app,waitFor,assert,adb,sleep}) {
  const {mkdir,writeFile}=await import('node:fs/promises');
  const {execFile}=await import('node:child_process');
  const folder=new URL('../output/agent-models-android/',import.meta.url);await mkdir(folder,{recursive:true});
  const results=[];
  for(const profile of ['z-image-turbo','h3-fl2va-lite']) {
    await app.evaluate('localStorage.setItem("i18nextLng","zh");location.href="/chat/new"; true').catch(()=>{});
    await waitFor(`location.pathname==='/chat/new' && !!document.querySelector('textarea:not(:disabled)')`,20000);
    const prefix=`ComfyMobileE2E/AgentModelsAndroid/${Date.now()}/${profile}`;
    const message=profile==='z-image-turbo'
      ? `使用 create_model_workflow 创建 z-image-turbo 模板，1024x1024，seed 42，提示词是「A small paper boat on a calm blue lake at sunrise」。filenamePrefix 设为 ${prefix}。实际预览一次并保存，最后报告结果，不要重复运行。`
      : `使用 create_model_workflow 创建 h3-fl2va-lite 模板，864x480、22帧、seed 42，提示词是「A small paper boat floating on a blue lake, gentle ripples, sunrise, soft wind and water sounds」。filenamePrefix 设为 ${prefix}。实际预览一次并保存，最后报告结果，不要重复运行。`;
    await app.evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(message)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await sleep(300);await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').click();true`);
    await waitFor(`location.pathname.startsWith('/chat/') && location.pathname!=='/chat/new'`,15000);
    const sessionId=await app.evaluate(`location.pathname.split('/').pop()`);
    assert(sessionId,`${profile}: agent session missing`);
    console.log(`    Model UI: ${profile} task submitted`);
    const outcome=await waitFor(`(()=>{const error=document.querySelector('[role=alert]');if(error)return {error:error.textContent};return !!document.querySelector('[data-agent-card="result"]')&&document.body.innerText.includes('已保存')&&!document.querySelector('footer [role=status]')?{done:true}:null})()`,420000);
    assert(!outcome.error,`${profile}: ${outcome.error}`);
    if(profile==='z-image-turbo') {
      await waitFor(`[...document.images].some(i=>i.alt.startsWith('生成结果')&&i.complete&&i.naturalWidth===1024&&i.naturalHeight===1024)`,30000);
    } else {
      const metadata=await waitFor(`(()=>{const v=document.querySelector('[data-agent-media=video] video');return v&&v.readyState>=2&&v.duration>0?{duration:v.duration,width:v.videoWidth,height:v.videoHeight}:null})()`,45000);
      assert(metadata.width===864 && metadata.height===480, 'unexpected H3 video size');
      const played=await app.evaluate(`(async()=>{const v=document.querySelector('video');v.muted=true;await v.play();await new Promise(r=>setTimeout(r,400));const time=v.currentTime;v.pause();return time})()`);
      assert(played>0,'H3 video did not play');
      results.push({profile,metadata,played});
    }
    await writeFile(new URL(`${profile}-conversation.txt`,folder),await app.evaluate('document.body.innerText'));
    const png=await new Promise((resolve,reject)=>execFile('adb',['-s',process.env.EMULATOR_SERIAL||'emulator-5554','exec-out','screencap','-p'],{encoding:'buffer'},(e,out)=>e?reject(e):resolve(out)));
    await writeFile(new URL(`${profile}.png`,folder),png);
    await app.evaluate(`[...document.querySelectorAll('button')].filter(b=>b.textContent.includes('在画布查看')).at(-1).click();true`);
    await waitFor(`location.pathname.startsWith('/workflow/')&&!!document.querySelector('[data-e2e-action=execute]')`,30000);
    results.push({profile,sessionId,openedInEditor:true});
    console.log(`    Model UI: ${profile} generated, displayed, saved and opened in editor`);
  }
  await writeFile(new URL('report.json',folder),JSON.stringify(results,null,2));
}
