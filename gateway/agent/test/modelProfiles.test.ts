import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {canvasToPrompt,promptToCanvas,applyCanvasPatch} from '../../workflow/canvas.js';
import {createModelWorkflow,modelTemplates} from '../modelProfiles.js';
import {validatePrompt} from '../../workflow/engine.js';
const folder=new URL('./model-fixtures/',import.meta.url);
const info=JSON.parse(readFileSync(new URL('object-info.json',folder),'utf8'));
for(const filename of readdirSync(folder).filter(f=>f!=='object-info.json')) test(`server reference imports and patches losslessly: ${filename}`,()=>{
 const canvas=JSON.parse(readFileSync(new URL(filename,folder),'utf8'));
 const prompt=canvasToPrompt(canvas,info);const rebuilt=promptToCanvas(canvas,prompt,info);
 assert.deepEqual(canvasToPrompt(rebuilt,info),prompt);
 const note=canvas.nodes.find((n:any)=>n.type==='MarkdownNote');assert.deepEqual(rebuilt.nodes.find(n=>n.id===note.id),note);
 const textNode=Object.entries(prompt).find(([,n])=>n.class_type==='CLIPTextEncode'||n.class_type==='MiniMaxH3ImageToVideo'||n.class_type==='MiniMaxH3ReferenceToVideo')!;
 const input=textNode[1].class_type==='CLIPTextEncode'?'text':'prompt';
 const changed=applyCanvasPatch({version:1,canvas},1,[{op:'set_input',nodeId:textNode[0],input,value:'Changed prompt'}],info);
 assert.equal(canvasToPrompt(changed.canvas,info)[textNode[0]].inputs[input],'Changed prompt');
 assert.deepEqual(changed.canvas.nodes.map(n=>n.pos),canvas.nodes.map((n:any)=>n.pos));
 const sampler=canvas.nodes.find((n:any)=>n.type==='KSampler');
 if(sampler){assert.equal(prompt[String(sampler.id)].inputs.steps,8);assert.equal(changed.canvas.nodes.find(n=>n.id===sampler.id)!.widgets_values!.length,6);}
});
test('all reviewed profiles create valid editable workflows with explicit reference inputs',()=>{
 assert.equal(modelTemplates(info).length,8);assert.ok(modelTemplates(info).every(p=>p.available));
 for(const profile of modelTemplates(info)){
  const canvas=createModelWorkflow(info,{profileId:profile.id,text:'A landscape',referenceImage:'ref_cat.png',referenceAudio:'ref_audio.wav',referenceVideo:'ref_clip.mp4',seed:42});
  const prompt=canvasToPrompt(canvas,info);assert.equal(validatePrompt(prompt,info).length,0);
  assert.deepEqual(canvasToPrompt(promptToCanvas(canvas,prompt,info),info),prompt);
 }
});
test('z-image img2img template wires the reference through LoadImage/VAEEncode with a tunable denoise',()=>{
 const listed=modelTemplates(info).find(p=>p.id==='z-image-turbo-img2img')!;
 assert.ok(listed.available);assert.deepEqual(listed.requiredInputs,['referenceImage']);assert.match(listed.description,/denoise/);
 assert.equal(listed.defaults.width,undefined,'img2img resolution follows the reference image');
 assert.throws(()=>createModelWorkflow(info,{profileId:'z-image-turbo-img2img',text:'x'}),/referenceImage/);
 assert.throws(()=>createModelWorkflow(info,{profileId:'z-image-turbo-img2img',text:'x',referenceImage:'ref_cat.png',width:1024}),/width\/height/);
 const canvas=createModelWorkflow(info,{profileId:'z-image-turbo-img2img',text:'x',referenceImage:'ref_cat.png'});
 const prompt=canvasToPrompt(canvas,info);
 assert.equal(prompt['17'].inputs.image,'ref_cat.png');
 assert.equal(prompt['18'].class_type,'ImageScaleToTotalPixels');assert.equal(prompt['7'].class_type,'VAEEncode');
 assert.deepEqual(prompt['7'].inputs.pixels,['18',0]);assert.equal(prompt['8'].inputs.denoise,0.55);
 const lighter=canvasToPrompt(createModelWorkflow(info,{profileId:'z-image-turbo-img2img',text:'x',referenceImage:'ref_cat.png',denoise:0.3}),info);
 assert.equal(lighter['8'].inputs.denoise,0.3);
 const txt2img=canvasToPrompt(createModelWorkflow(info,{profileId:'z-image-turbo',text:'x',denoise:0.3}),info);
 assert.equal(txt2img['8'].inputs.denoise,1,'denoise never applies to text-to-image templates');
});
test('missing models and references are diagnosed; wrong geometry/frames rejected',()=>{
 const missing=structuredClone(info);missing.UNETLoader.input.required.unet_name[0]=[];
 assert.equal(modelTemplates(missing).find(p=>p.id==='z-image-turbo')!.available,false);
 assert.throws(()=>createModelWorkflow(info,{profileId:'h3-ref-image',text:'x'}),/referenceImage/);
 assert.throws(()=>createModelWorkflow(info,{profileId:'h3-fl2va',text:'x',frames:24}),/17k\+5/);
 assert.throws(()=>createModelWorkflow(info,{profileId:'h3-fl2va',text:'x',width:865}),/multiples of 32/);
 assert.throws(()=>createModelWorkflow(info,{profileId:'h3-ref-video',text:'x',referenceVideo:'missing.mp4'}),/Unavailable/);
 const q6=createModelWorkflow(info,{profileId:'h3-fl2va',text:'x',modelVariant:'q6'});
 assert.match(String(canvasToPrompt(q6,info)['1'].inputs.unet_name),/Q6_K/);
});
test('autogrow reference slots are typed and bounded; dynamic combo choices validated',()=>{
 const p=canvasToPrompt(createModelWorkflow(info,{profileId:'h3-ref-image',text:'x',referenceImage:'ref_cat.png'}),info);
 p['7'].inputs['ref_images.ref_image_99']=['17',0];assert.ok(validatePrompt(p,info).some(d=>d.code==='unknown_input'));
 delete p['7'].inputs['ref_images.ref_image_99'];p['7'].inputs['ref_images.ref_image_0']=['4',0];assert.ok(validatePrompt(p,info).some(d=>d.code==='incompatible_link'));
 p['16'].inputs.format='invalid';assert.ok(validatePrompt(p,info).some(d=>d.code==='invalid_choice'));
});

