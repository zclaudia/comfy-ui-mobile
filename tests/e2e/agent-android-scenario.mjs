// Optional real-provider scenario for the existing emulator-only suite.
export async function agentAndroidScenario({ app, waitFor, assert, admin, adb, connect, pkg, activity, sleep, videoOutput }) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const outputDir = new URL('../output/agent-android/', import.meta.url);
  await mkdir(outputDir, { recursive: true });
  const { default: sharp } = await import('sharp');
  const fixture = await sharp({ create: { width:64, height:64, channels:3, background:'#3264b4' } }).png().toBuffer();
  const upload = new FormData();
  upload.append('image', new Blob([fixture], {type:'image/png'}), `ComfyMobileE2E-AgentAndroid-${Date.now()}.png`);
  const response = await admin('/upload/image', {method:'POST', body:upload});
  assert(response.ok, 'agent input fixture upload failed');
  const uploaded = await response.json();
  const input = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
  await app.evaluate('localStorage.setItem("i18nextLng","zh");location.href = "/chat/new?pick=1"; "nav"').catch(() => {});
  await waitFor(`!!document.querySelector('[data-agent-pick]')`, 20000);
  const picked = await app.evaluate(`(() => { const b = [...document.querySelectorAll('[data-agent-pick]')].find(b => b.dataset.agentPick.includes('ComfyMobileAndroidE2E')); if (!b) return false; b.click(); return true; })()`);
  assert(picked, 'test workflow missing in agent workflow picker');
  await waitFor(`!!document.querySelector('textarea:not(:disabled)') && document.body.innerText.includes('已载入工作流')`, 15000);
  const prefix = `ComfyMobileE2E/AgentAndroid/${Date.now()}`;
  const message = `请调试当前工作流：把 LoadImage 的 image 改为 ${input}，SaveImage 的 filename_prefix 改为 ${prefix}。检查工作流，然后实际执行一次预览，成功后保存版本并用中文总结。最多执行一次，不要创建新模板。`;
  await app.evaluate(`(() => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(message)});
    input.dispatchEvent(new Event('input', {bubbles:true})); return true;
  })()`);
  await sleep(300);
  await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').click(); true`);
  await waitFor(`location.pathname.startsWith('/chat/') && location.pathname !== '/chat/new'`, 15000);
  const sessionId = await app.evaluate(`location.pathname.split('/').pop()`);
  assert(sessionId, 'agent session missing');
  console.log('    Agent: real MiniMax task submitted from Android UI');
  await waitFor(`!!document.querySelector('[data-agent-card="result"]') && !!document.querySelector('[data-agent-card="workflow"]') && document.body.innerText.includes('已保存') && !document.querySelector('footer [role=status]')`, 240000);
  await waitFor(`[...document.images].some(i => i.alt.startsWith('生成结果') && i.complete && i.naturalWidth > 0)`, 20000);
  assert(await app.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'agent UI overflows horizontally');
  const text = await app.evaluate('document.body.innerText');
  await writeFile(new URL('conversation.txt', outputDir), text);
  const { execFile } = await import('node:child_process');
  const png = await new Promise((resolve, reject) => execFile('adb', ['-s', process.env.EMULATOR_SERIAL || 'emulator-5554', 'exec-out', 'screencap', '-p'], {encoding:'buffer'}, (error, stdout) => error ? reject(error) : resolve(stdout)));
  await writeFile(new URL('result.png', outputDir), png);
  const history = await (await admin('/history?max_items=100')).json();
  const runs = Object.values(history).filter(run => Object.values(run.outputs || {}).some(out => out.images?.some(image => `${image.subfolder}/${image.filename}`.includes(prefix))));
  assert(runs.length === 1, `expected exactly one real agent run, got ${runs.length}`);
  // Administrator cannot read a device-owned agent session.
  assert((await admin(`/api/gateway/agent/sessions/${sessionId}`)).status === 404, 'agent session owner isolation failed');
  // The bound workflow now exists in the library; the chat header opens it and the editor links back.
  await app.evaluate(`document.querySelector('[data-agent-open-canvas]').click(); true`);
  await waitFor(`location.pathname.startsWith('/workflow/') && !!document.querySelector('[data-e2e-action="open-chat"]')`, 15000);
  await app.evaluate(`document.querySelector('[data-e2e-action="open-chat"]').click(); true`);
  await waitFor(`location.pathname === "/chat/" + ${JSON.stringify(sessionId)}`, 15000);
  console.log('    Agent: canvas <-> chat round trip verified');
  await adb('shell', 'am', 'force-stop', pkg);
  await adb('shell', 'am', 'start', '-n', activity);
  await sleep(8000);
  const connection = await connect();
  app.evaluate = connection.evaluate; app.close = () => connection.ws.close();
  await app.evaluate(`localStorage.setItem("i18nextLng","zh");location.href = "/chat/" + ${JSON.stringify(sessionId)}; "nav"`).catch(() => {});
  await waitFor(`location.pathname === "/chat/" + ${JSON.stringify(sessionId)} && !!document.querySelector('[data-agent-card="result"]')`, 25000);
  const applicationCases = ['repair-preview-save', 'cold-start-recovery', 'device-session-isolation'];
  async function sendMessage(text) {
    await app.evaluate(`(() => {
      const input = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', {bubbles:true})); return true;
    })()`);
    await sleep(250);
    await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').click(); true`);
    await waitFor(`!!document.querySelector('footer [role=status] button:not([disabled])')`, 15000);
  }
  async function idle() { await waitFor(`!document.querySelector('footer [role=status]')`, 180000); }
  assert(await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').disabled`), 'empty message send is enabled');
  applicationCases.push('empty-message-disabled');
  const prefix2 = prefix + '/followup';
  await sendMessage(`继续修改：只把 SaveImage.filename_prefix 改为 ${prefix2}，校验并保存，不要运行。`);
  assert(await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').disabled`), 'active task allows another send');
  // Leave while the real model works; re-entry must recover the server-owned task.
  await app.evaluate('localStorage.setItem("i18nextLng","zh");location.href = "/chats"; "nav"').catch(() => {});
  await sleep(1500);
  await app.evaluate(`localStorage.setItem("i18nextLng","zh");location.href = "/chat/" + ${JSON.stringify(sessionId)}; "nav"`).catch(() => {});
  await waitFor(`document.body.innerText.includes('版本 3 已保存') && !document.querySelector('footer [role=status]')`, 180000);
  assert(await app.evaluate(`document.body.innerText.includes(${JSON.stringify(prefix2)})`), 'follow-up edit not visible');
  applicationCases.push('followup-edit-without-preview', 'background-navigation-recovery', 'active-task-send-disabled');
  console.log('    Agent UI: multi-turn edits and leaving/reopening page passed');
  // Restore the imported v1 through the actual version-history controls (header menu -> sheet).
  const menuPoint = await app.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="更多"]');
    const rect = button.getBoundingClientRect();
    return {x:Math.round((rect.x + rect.width / 2) * devicePixelRatio),centerY:Math.round((rect.y + rect.height / 2) * devicePixelRatio),lowerY:Math.round((rect.bottom - 3) * devicePixelRatio),headerPadding:getComputedStyle(document.querySelector('header')).paddingTop};
  })()`);
  const menuVisible = `[...document.querySelectorAll('[role="menuitem"]')].some(m => m.textContent.includes('版本历史'))`;
  await adb('shell', 'input', 'tap', String(menuPoint.x), String(menuPoint.centerY));
  const centerOpened = !!await waitFor(menuVisible, 2000).catch(() => false);
  let lowerOpened = false;
  if (!centerOpened) {
    await adb('shell', 'input', 'tap', String(menuPoint.x), String(menuPoint.lowerY));
    lowerOpened = !!await waitFor(menuVisible, 2000).catch(() => false);
    if (!lowerOpened) {
      // Continue the other scenarios with keyboard activation, but fail the touch assertion at the end.
      await app.evaluate(`(() => { const b = document.querySelector('button[aria-label="更多"]'); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true})); return true; })()`);
    }
  }
  await waitFor(menuVisible, 5000);
  const menuTouch = {...menuPoint,centerOpened,lowerOpened};
  console.log('    Agent menu touch:', JSON.stringify(menuTouch));
  await app.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(m => m.textContent.includes('版本历史')).click(); true`);
  await waitFor(`!!document.querySelector('[role="dialog"]')`, 10000);
  await app.evaluate(`(() => {
    const restore = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.includes('回到这个版本') && b.closest('div').textContent.includes('V1'));
    restore.click(); return true;
  })()`);
  await waitFor(`document.querySelector('h1')?.nextElementSibling?.textContent.includes('V4')`, 15000);
  applicationCases.push('restore-old-version-as-v4');
  await sendMessage('仔细检查当前工作流并逐个解释节点和参数，只解释，不修改或执行。');
  await app.evaluate(`document.querySelector('footer [role=status] button').click(); true`);
  await waitFor(`document.body.innerText.includes('助手已停止；已提交的生成可能继续运行') && !document.querySelector('footer [role=status]')`, 15000);
  applicationCases.push('cancel-task');
  await sendMessage('只回复一句话：工作流助手可以继续使用。不调用工具，不执行工作流。');
  await idle();
  assert(await app.evaluate(`[...document.querySelectorAll('article')].some(a => a.querySelector('p')?.textContent === '助手' && a.textContent.includes('工作流助手可以继续使用'))`), 'cannot continue cancelled conversation');
  applicationCases.push('continue-after-cancel');
  // Independent blank conversation, then switch back to the edited conversation.
  await app.evaluate('location.href = "/chat/new"; true').catch(() => {});
  await waitFor(`location.pathname === '/chat/new' && !!document.querySelector('textarea') && !document.querySelector('textarea').disabled`, 15000);
  assert(await app.evaluate(`!document.body.innerText.includes(${JSON.stringify(prefix2)})`), 'new session contains previous conversation');
  await app.evaluate(`location.href = "/chat/" + ${JSON.stringify(sessionId)}; true`).catch(() => {});
  await waitFor(`location.pathname === "/chat/" + ${JSON.stringify(sessionId)} && document.body.innerText.includes('从版本 1 恢复')`, 15000);
  applicationCases.push('new-session-and-switch-back');
  // Exercise the actual file-input and paste handlers with generated test media.
  // This covers uploads and chat rendering, but not the Android system file-picker UI.
  const attachmentName = `ComfyMobileE2E-chat-${Date.now()}.png`;
  async function addImage(method = 'change', count = 1) {
    await app.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(fixture.toString('base64'))}), c => c.charCodeAt(0));
      const transfer = new DataTransfer();
      for (let i = 0; i < ${count}; i++) transfer.items.add(new File([bytes], ${JSON.stringify(attachmentName)}.replace('.png', '-' + i + '.png'), {type:'image/png'}));
      if (${JSON.stringify(method)} === 'paste') {
        document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', {clipboardData:transfer,bubbles:true,cancelable:true}));
      } else {
        const picker = document.querySelector('[data-agent-composer] input[type=file]');
        picker.files = transfer.files; picker.dispatchEvent(new Event('change', {bubbles:true}));
      }
      return true;
    })()`);
  }
  await addImage('change', 9);
  await waitFor(`document.querySelectorAll('[data-attachment-status]').length === 8 && document.querySelectorAll('[data-attachment-status="done"]').length === 8`, 30000);
  assert(await app.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'eight attachments overflow page');
  await app.evaluate(`[...document.querySelectorAll('button[aria-label="移除附件"]')].forEach(b => b.click()); true`);
  await waitFor(`!document.querySelector('[data-attachment-status]')`, 10000);
  assert(await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').disabled`), 'removing attachments leaves empty send enabled');
  applicationCases.push('attachment-eight-file-limit', 'remove-all-attachments');
  await addImage('paste');
  await waitFor(`!!document.querySelector('[data-attachment-status="done"]') && !document.querySelector('button[aria-label="发送消息"]').disabled`, 30000);
  assert(await app.evaluate(`document.querySelector('textarea').value === ''`), 'attachment-only test unexpectedly contains text');
  await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').click(); true`);
  await waitFor(`!!document.querySelector('ul[aria-label="消息附件"]') && !document.querySelector('[data-attachment-status]')`, 15000);
  await idle();
  // Android media is loaded by IntersectionObserver only when it is visible.
  await app.evaluate(`document.querySelector('ul[aria-label="消息附件"] img').scrollIntoView({block:'center'}); true`);
  await waitFor(`[...document.querySelectorAll('ul[aria-label="消息附件"] img')].some(i => i.complete && i.naturalWidth === 64)`, 20000);
  assert(await app.evaluate(`[...document.querySelectorAll('[data-agent-turn]')].at(-1)?.querySelector('[data-turn-status]')?.dataset.turnStatus === 'complete'`), 'attachment-only conversation did not complete');
  applicationCases.push('paste-image-upload', 'attachment-only-send', 'sent-image-authenticated-preview');
  await app.evaluate('location.reload(); true').catch(() => {});
  await waitFor(`!!document.querySelector('ul[aria-label="消息附件"] img')`, 20000);
  await app.evaluate(`document.querySelector('ul[aria-label="消息附件"] img').scrollIntoView({block:'center'}); true`);
  await waitFor(`[...document.querySelectorAll('ul[aria-label="消息附件"] img')].some(i => i.complete && i.naturalWidth === 64)`, 25000);
  applicationCases.push('attachment-reload-persistence');
  // Standalone callers can reuse a generated E2E fixture; never choose user media.
  if (!videoOutput) {
    const fixtureHistory = await (await admin('/history?max_items=100')).json();
    videoOutput = Object.values(fixtureHistory).flatMap(run => Object.values(run.outputs || {}))
      .flatMap(output => [...(output.images || []), ...(output.gifs || []), ...(output.videos || [])])
      .find(output => output.subfolder?.startsWith('ComfyMobileE2E/Android/Video') && output.filename?.endsWith('.mp4'));
  }
  assert(videoOutput, 'generated E2E video fixture is missing');
  const videoResponse = await admin('/view?' + new URLSearchParams(videoOutput));
  assert(videoResponse.ok, 'generated E2E video could not be read');
  const videoBytes = Buffer.from(await videoResponse.arrayBuffer());
  // A short, valid 8kHz mono PCM WAV containing silence.
  const wav = Buffer.alloc(44 + 1600);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(1600, 40);
  const mediaFiles = [
    {name:attachmentName.replace('.png', '.mp4'),type:'video/mp4',bytes:videoBytes.toString('base64')},
    {name:attachmentName.replace('.png', '.wav'),type:'audio/wav',bytes:wav.toString('base64')},
  ];
  await app.evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const media of ${JSON.stringify(mediaFiles)}) transfer.items.add(new File([Uint8Array.from(atob(media.bytes), c => c.charCodeAt(0))], media.name, {type:media.type}));
    const picker = document.querySelector('[data-agent-composer] input[type=file]');
    picker.files = transfer.files; picker.dispatchEvent(new Event('change', {bubbles:true})); return true;
  })()`);
  await waitFor(`document.querySelectorAll('[data-attachment-status="done"]').length === 2`, 30000);
  await sendMessage('只列出这条消息附带的两个文件的类型和完整文件路径，不修改、不保存、不执行工作流。');
  await idle();
  assert(await app.evaluate(`[...document.querySelectorAll('[data-agent-turn]')].at(-1)?.querySelector('[data-turn-status]')?.dataset.turnStatus === 'complete'`), 'media attachment conversation did not complete');
  for (const media of mediaFiles) {
    assert(await app.evaluate(`[...document.querySelectorAll('ul[aria-label="消息附件"] li')].some(li => li.title === ${JSON.stringify(media.name)})`), 'sent media tile missing');
  }
  applicationCases.push('video-audio-upload', 'mixed-media-message');
  await app.evaluate(`[...document.querySelectorAll('[data-agent-turn]')].at(-1)?.scrollIntoView({block:'end'}); true`);
  await sleep(300);
  const attachmentPng = await new Promise((resolve, reject) => execFile('adb', ['-s', process.env.EMULATOR_SERIAL || 'emulator-5554', 'exec-out', 'screencap', '-p'], {encoding:'buffer'}, (error, stdout) => error ? reject(error) : resolve(stdout)));
  await writeFile(new URL('attachments.png', outputDir), attachmentPng);
  await writeFile(new URL('attachments-conversation.txt', outputDir), await app.evaluate('document.body.innerText'));
  const latestHistory = await (await admin('/history?max_items=100')).json();
  const allRuns = Object.values(latestHistory).filter(run => Object.values(run.outputs || {}).some(out => out.images?.some(image => `${image.subfolder}/${image.filename}`.includes(prefix))));
  assert(allRuns.length === 1, 'read-only, edit or cancelled tasks unexpectedly ran ComfyUI');
  await writeFile(new URL('expanded-conversation.txt', outputDir), await app.evaluate('document.body.innerText'));
  console.log('    Agent UI: restore, cancel, continue, and session switching passed');
  await app.evaluate(`[...document.querySelectorAll('button')].filter(b => b.textContent.includes('在画布查看')).at(-1).click(); true`);
  await waitFor(`location.pathname.startsWith('/workflow/') && !!document.querySelector('[data-e2e-action=execute]')`, 20000);
  await writeFile(new URL('report.json', outputDir), JSON.stringify({ sessionId, prefix, realRuns:runs.length, imageLoaded:true, restoredAfterColdStart:true, openedInEditor:true, ownerIsolation:true, applicationCases, menuTouch }, null, 2));
  assert(centerOpened, 'chat header menu cannot be opened by tapping its center; see menuTouch in report.json');
}
