/** Real GPU acceptance for reviewed templates. No LLM mocks or user reference assets. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {createModelWorkflow,modelTemplates} from '../../gateway/dist/agent/modelProfiles.js';
import {canvasToPrompt} from '../../gateway/dist/workflow/canvas.js';
import {collectMediaOutputs} from '../../gateway/dist/agent/media.js';
if(process.env.E2E_MODELS_LIVE!=='1')throw Error('E2E_MODELS_LIVE=1 required: runs actual GPU generation');
const url=process.env.E2E_GATEWAY_URL||'https://comfy.zhvala.space:28443';const token=process.env.E2E_GATEWAY_TOKEN;if(!token)throw Error('E2E_GATEWAY_TOKEN required');
assert.ok(!process.env.TEST_MODEL_VARIANT || ['q5','q6'].includes(process.env.TEST_MODEL_VARIANT),'Invalid TEST_MODEL_VARIANT');
const id=randomUUID();const folder=new URL(`../output/model-adaptation/${id}/`,import.meta.url);await mkdir(folder,{recursive:true});
async function req(path,options={}){return fetch(url+path,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers},signal:AbortSignal.timeout(30000)});}
async function upload(bytes,name){const form=new FormData();form.append('image',new Blob([bytes]),name);form.append('overwrite','false');const r=await req('/upload/image',{method:'POST',body:form});assert.equal(r.status,200);const o=await r.json();return o.subfolder?`${o.subfolder}/${o.name}`:o.name;}
const image=await sharp({create:{width:512,height:512,channels:3,background:'#6090b0'}}).png().toBuffer();
const referenceImage=await upload(image,`ComfyMobileE2E-ref-${id}.png`);
const ffmpeg=promisify(execFile);
await ffmpeg('ffmpeg',['-y','-f','lavfi','-i','sine=frequency=440:sample_rate=32000:duration=1','-filter:a','volume=0.1',new URL('ref.wav',folder).pathname]);
await ffmpeg('ffmpeg',['-y','-f','lavfi','-i','color=c=steelblue:s=432x240:r=24:d=0.92','-f','lavfi','-i','sine=frequency=440:sample_rate=32000:duration=0.92','-frames:v','22','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',new URL('ref.mp4',folder).pathname]);
const referenceAudio=await upload(await readFile(new URL('ref.wav',folder)),`ComfyMobileE2E-ref-${id}.wav`);
const referenceVideo=await upload(await readFile(new URL('ref.mp4',folder)),`ComfyMobileE2E-ref-${id}.mp4`);
const info=await (await req('/object_info')).json();const profiles=modelTemplates(info);
const selected=process.env.TEST_PROFILE_IDS?.split(',')||profiles.map(p=>p.id);
assert.ok(selected.every(id=>profiles.some(p=>p.id===id)));
const report=[];
for(const profileId of selected){
 const start=Date.now();const profile=profiles.find(p=>p.id===profileId);assert.equal(profile.available,true,JSON.stringify(profile.missing));
 const canvas=createModelWorkflow(info,{profileId,...(process.env.TEST_MODEL_VARIANT?{modelVariant:process.env.TEST_MODEL_VARIANT}:{}),text:'A small paper boat floating on a calm blue lake, warm sunrise, gentle ripples, cinematic lighting. Soft wind and water ambience.',seed:42,referenceImage,referenceAudio,referenceVideo,filenamePrefix:`ComfyMobileE2E/Models/${id}/${profileId}`});
 await writeFile(new URL(`${profileId}.json`,folder),JSON.stringify(canvas,null,2));
 const prompt=canvasToPrompt(canvas,info);const submitted=await req('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,client_id:randomUUID(),extra_data:{extra_pnginfo:{workflow:canvas}}})});
 const body=await submitted.json();assert.equal(submitted.status,200,JSON.stringify(body));console.log(JSON.stringify({profileId,phase:'submitted',promptId:body.prompt_id}));
 let result;for(let tick=0;tick<200;tick++){
  const history=await (await req(`/history/${body.prompt_id}`)).json();const run=history[body.prompt_id];
  if(run?.status?.completed||run?.status?.status_str==='error'){result=run;break;}
  await new Promise(r=>setTimeout(r,3000));
 }
 assert.ok(result,`Timeout for ${body.prompt_id}; inspect history before rerunning`);
 await writeFile(new URL(`${profileId}-history.json`,folder),JSON.stringify(result,null,2));
 assert.equal(result.status.status_str,'success',JSON.stringify(result.status.messages));
 const outputs=collectMediaOutputs(result.outputs);assert.ok(outputs.some(o=>o.kind===profile.media));
 for(const [index,output]of outputs.entries()){
  const r=await req('/view?'+new URLSearchParams({filename:output.filename,subfolder:output.subfolder,type:output.type}));assert.equal(r.status,200);
  const bytes=Buffer.from(await r.arrayBuffer());const local=new URL(`${profileId}-${index}.${output.filename.split('.').at(-1)}`,folder);await writeFile(local,bytes);
  if(output.kind==='image'){const meta=await sharp(bytes).metadata();assert.equal(meta.width,profile.defaults.width);assert.equal(meta.height,profile.defaults.height);}
  else if(output.kind==='video'){
   const {stdout}=await ffmpeg('ffprobe',['-v','quiet','-show_streams','-show_format','-of','json',local.pathname]);const metadata=JSON.parse(stdout);
   assert.ok(Number(metadata.format.duration)>0);assert.ok(metadata.streams.some(s=>s.codec_type==='video'));assert.ok(metadata.streams.some(s=>s.codec_type==='audio'));
   await writeFile(new URL(`${profileId}-media.json`,folder),JSON.stringify(metadata,null,2));
  }
 }
 report.push({profileId,modelVariant:process.env.TEST_MODEL_VARIANT??'default',promptId:body.prompt_id,elapsedMs:Date.now()-start,outputs});await writeFile(new URL('report.json',folder),JSON.stringify(report,null,2));
 console.log(JSON.stringify({profileId,phase:'passed',seconds:Math.round((Date.now()-start)/1000),outputs:outputs.map(o=>o.kind)}));
}
console.log(`MODEL_REPORT=${folder.pathname}report.json`);
