// Optional real-provider scenario for the existing emulator-only suite.
export async function agentAndroidScenario({ app, waitFor, assert, admin, adb, connect, pkg, activity, sleep }) {
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
  await app.evaluate('localStorage.setItem("i18nextLng","zh");location.href = "/agent"; "nav"').catch(() => {});
  await waitFor(`!!document.querySelector('select[aria-label="导入工作流"]')`, 20000);
  const imported = await app.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="导入工作流"]');
    const option = [...select.options].find(o => o.textContent.includes('ComfyMobileAndroidE2E'));
    if (!option) return false;
    select.value = option.value; select.dispatchEvent(new Event('change', {bubbles:true})); return true;
  })()`);
  assert(imported, 'test workflow missing in agent import selector');
  await sleep(300);
  await app.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '新建').click(); true`);
  await waitFor(`!!document.querySelector('textarea:not(:disabled)')`, 15000);
  const sessionId = await app.evaluate(`document.querySelector('select[aria-label="选择会话"]').value`);
  assert(sessionId, 'agent session missing');
  const prefix = `ComfyMobileE2E/AgentAndroid/${Date.now()}`;
  const message = `请调试当前工作流：把 LoadImage 的 image 改为 ${input}，SaveImage 的 filename_prefix 改为 ${prefix}。检查工作流，然后实际执行一次预览，成功后保存版本并用中文总结。最多执行一次，不要创建新模板。`;
  await app.evaluate(`(() => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(message)});
    input.dispatchEvent(new Event('input', {bubbles:true})); return true;
  })()`);
  await sleep(300);
  await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').click(); true`);
  console.log('    Agent: real MiniMax task submitted from Android UI');
  await waitFor(`document.body.innerText.includes('生成结果 · v') && document.body.innerText.includes('已保存') && !document.querySelector('footer [role=status]')`, 240000);
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
  await adb('shell', 'am', 'force-stop', pkg);
  await adb('shell', 'am', 'start', '-n', activity);
  await sleep(8000);
  const connection = await connect();
  app.evaluate = connection.evaluate; app.close = () => connection.ws.close();
  await app.evaluate('localStorage.setItem("i18nextLng","zh");location.href = "/agent"; "nav"').catch(() => {});
  await waitFor(`document.querySelector('select[aria-label="选择会话"]')?.value === ${JSON.stringify(sessionId)} && document.body.innerText.includes('已保存')`, 25000);
  const applicationCases = ['repair-preview-save', 'cold-start-recovery', 'device-session-isolation'];
  async function sendMessage(text) {
    await app.evaluate(`(() => {
      const input = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', {bubbles:true})); return true;
    })()`);
    await sleep(250);
    await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('footer button')].some(b => b.textContent.includes('停止助手') && !b.disabled)`, 15000);
  }
  async function idle() { await waitFor(`!document.querySelector('footer [role=status]')`, 180000); }
  assert(await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').disabled`), 'empty message send is enabled');
  applicationCases.push('empty-message-disabled');
  const prefix2 = prefix + '/followup';
  await sendMessage(`继续修改：只把 SaveImage.filename_prefix 改为 ${prefix2}，校验并保存，不要运行。`);
  assert(await app.evaluate(`document.querySelector('button[aria-label="发送消息"]').disabled`), 'active task allows another send');
  // Leave while the real model works; re-entry must recover the server-owned task.
  await app.evaluate('localStorage.setItem("i18nextLng","zh");location.href = "/"; "nav"').catch(() => {});
  await sleep(1500);
  await app.evaluate('localStorage.setItem("i18nextLng","zh");location.href = "/agent"; "nav"').catch(() => {});
  await waitFor(`document.body.innerText.includes('版本 3 已保存') && !document.querySelector('footer [role=status]')`, 180000);
  assert(await app.evaluate(`document.body.innerText.includes(${JSON.stringify(prefix2)})`), 'follow-up edit not visible');
  applicationCases.push('followup-edit-without-preview', 'background-navigation-recovery', 'active-task-send-disabled');
  console.log('    Agent UI: multi-turn edits and leaving/reopening page passed');
  // Restore the imported v1 through the actual version-history controls.
  await app.evaluate(`(() => {
    const history = [...document.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent.includes('版本历史'));
    history.open = true;
    const row = [...history.children].find(e => e.tagName === 'DIV' && e.querySelector('p')?.textContent.startsWith('v1 ·'));
    [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '恢复').click(); return true;
  })()`);
  await waitFor(`document.querySelector('select[aria-label="选择会话"]')?.selectedOptions[0]?.textContent.includes('v4')`, 15000);
  applicationCases.push('restore-old-version-as-v4');
  await sendMessage('仔细检查当前工作流并逐个解释节点和参数，只解释，不修改或执行。');
  await app.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('停止助手')).click(); true`);
  await waitFor(`document.body.innerText.includes('助手任务已停止') && !document.querySelector('footer [role=status]')`, 15000);
  applicationCases.push('cancel-task');
  await sendMessage('只回复一句话：工作流助手可以继续使用。不调用工具，不执行工作流。');
  await idle();
  assert(await app.evaluate(`[...document.querySelectorAll('article')].some(a => a.querySelector('p')?.textContent === '助手' && a.textContent.includes('工作流助手可以继续使用'))`), 'cannot continue cancelled conversation');
  applicationCases.push('continue-after-cancel');
  // Independent blank conversation, then switch back to the edited conversation.
  await app.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '新建').click(); true`);
  await waitFor(`document.querySelector('select[aria-label="选择会话"]')?.value !== ${JSON.stringify(sessionId)} && !document.querySelector('textarea').disabled`, 15000);
  assert(await app.evaluate(`!document.body.innerText.includes(${JSON.stringify(prefix2)})`), 'new session contains previous conversation');
  await app.evaluate(`(() => {const select=document.querySelector('select[aria-label="选择会话"]');select.value=${JSON.stringify(sessionId)};select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await waitFor(`document.body.innerText.includes('从版本 1 恢复')`, 15000);
  applicationCases.push('new-session-and-switch-back');
  const latestHistory = await (await admin('/history?max_items=100')).json();
  const allRuns = Object.values(latestHistory).filter(run => Object.values(run.outputs || {}).some(out => out.images?.some(image => `${image.subfolder}/${image.filename}`.includes(prefix))));
  assert(allRuns.length === 1, 'read-only, edit or cancelled tasks unexpectedly ran ComfyUI');
  await writeFile(new URL('expanded-conversation.txt', outputDir), await app.evaluate('document.body.innerText'));
  console.log('    Agent UI: restore, cancel, continue, and session switching passed');
  await app.evaluate(`[...document.querySelectorAll('button')].filter(b => b.textContent.includes('在画布打开副本')).at(-1).click(); true`);
  await waitFor(`location.pathname.startsWith('/workflow/') && !!document.querySelector('[data-e2e-action=execute]')`, 20000);
  await writeFile(new URL('report.json', outputDir), JSON.stringify({ sessionId, prefix, realRuns:runs.length, imageLoaded:true, restoredAfterColdStart:true, openedInEditor:true, ownerIsolation:true, applicationCases }, null, 2));
}
