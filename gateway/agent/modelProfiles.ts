import { modelProfileData } from './modelProfileData.js';
import { canvasFromPrompt } from './templates.js';
import { validatePrompt, WorkflowError } from '../workflow/engine.js';
import type { ObjectInfo, Prompt } from '../workflow/engine.js';

const assetTypes = new Set(['LoadImage','LoadAudio','LoadVideo']);
export function modelTemplates(info: ObjectInfo) {
  return modelProfileData.map(profile => {
    const prompt = structuredClone(profile.prompt) as unknown as Prompt;
    const diagnostics = validatePrompt(prompt, info).filter(d => d.code !== 'invalid_choice' || !d.nodeId || !assetTypes.has(prompt[d.nodeId]?.class_type));
    const fallbackDescription = profile.id.startsWith('z-image') ? 'Z-Image Turbo image generation; lumina2 CLIP, CFG 1, 8 steps, zero negative conditioning.' : 'MiniMax H3 joint video/audio; frames must be 17k+5, width/height multiples of 32. Short preview default: 22 frames. Reference assets must be explicitly selected by the user.';
    const latentInputs = profile.prompt['7'].inputs as Record<string, unknown>;
    return { id:profile.id, media:profile.media, available:diagnostics.length===0, missing:diagnostics,
      requiredInputs:'reference' in profile ? [profile.reference] : [],
      defaults: { ...(latentInputs.width !== undefined ? {width:latentInputs.width as number, height:latentInputs.height as number} : {}), ...('length' in latentInputs ? {frames:latentInputs.length as number, fps:24} : {})},
      description: 'description' in profile && typeof profile.description === 'string' ? profile.description : fallbackDescription,
    };
  });
}
export interface ModelWorkflowOptions {
  profileId:string; text:string; width?:number; height?:number; frames?:number; seed?:number;
  referenceImage?:string; referenceAudio?:string; referenceVideo?:string; denoise?:number;
  modelVariant?:'q5'|'q6'; filenamePrefix?:string;
}
export function createModelWorkflow(info: ObjectInfo, options:ModelWorkflowOptions) {
  const profile=modelProfileData.find(p=>p.id===options.profileId);
  const fail=(message:string):never=>{throw new WorkflowError([{code:'model_profile',message}]);};
  if(!profile) return fail('Unknown model template');
  if('reference' in profile && !options[profile.reference]?.trim()) return fail(`This template requires an explicitly selected ${profile.reference}`);
  const prompt=structuredClone(profile.prompt) as unknown as Prompt;
  if(profile.media==='image' && options.frames!==undefined) fail('Image templates do not accept frame count');
  // Node 7 carries the latent/video size on every template except reference-derived ones (VAEEncode follows the image).
  if(!('width' in profile.prompt['7'].inputs) && (options.width!==undefined || options.height!==undefined)) fail('This template derives resolution from the reference image; width/height are not settable');
  if(profile.id.startsWith('z-image') && options.modelVariant) fail('GGUF variants apply only to H3');
  if(profile.id.startsWith('h3-ref') && options.modelVariant==='q6') fail('Ref2VA Q6 is not in the reviewed model set');
  for(const node of Object.values(prompt)) {
    const input=node.inputs;
    if(node.class_type==='CLIPTextEncode') input.text=options.text;
    if(node.class_type==='MiniMaxH3ImageToVideo' || node.class_type==='MiniMaxH3ReferenceToVideo') {
      const tag='reference' in profile ? {referenceImage:'<Picture 1>',referenceAudio:'<Audio 1>',referenceVideo:'<Audio 1> <Video 1>'}[profile.reference] : '';
      input.prompt=tag && !options.text.includes(tag) ? `${tag} ${options.text}` : options.text;
      if(options.frames!==undefined) input.length=options.frames;
    }
    if(['EmptySD3LatentImage','MiniMaxH3ImageToVideo','MiniMaxH3ReferenceToVideo'].includes(node.class_type)) {
      if(options.width!==undefined) input.width=options.width;
      if(options.height!==undefined) input.height=options.height;
    }
    if(node.class_type==='KSampler' && options.seed!==undefined) input.seed=options.seed;
    if(node.class_type==='KSampler' && 'reference' in profile && options.denoise!==undefined) input.denoise=options.denoise;
    if(node.class_type==='RandomNoise' && options.seed!==undefined) input.noise_seed=options.seed;
    if(node.class_type==='LoadImage') input.image=options.referenceImage!;
    if(node.class_type==='LoadAudio') input.audio=options.referenceAudio!;
    if(node.class_type==='LoadVideo') input.file=options.referenceVideo!;
    if(node.class_type==='UnetLoaderGGUF' && options.modelVariant==='q6') input.unet_name='MiniMax-H3-FL2VA-Pruned-Q6_K.gguf';
    if('filename_prefix' in input && options.filenamePrefix) input.filename_prefix=options.filenamePrefix;
  }
  return canvasFromPrompt(prompt,info);
}
