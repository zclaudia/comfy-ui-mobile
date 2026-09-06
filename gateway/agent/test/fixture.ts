import type { ObjectInfo } from '../../workflow/engine.js';
export const info: ObjectInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['v1-5-pruned-emaonly-fp16.safetensors']] } }, output: ['MODEL', 'CLIP', 'VAE'] },
  CLIPTextEncode: { input: { required: { text: ['STRING'], clip: ['CLIP'] } }, output: ['CONDITIONING'] },
  EmptyLatentImage: { input: { required: { width: ['INT', { min: 64, max: 4096 }], height: ['INT', { min: 64, max: 4096 }], batch_size: ['INT', { min: 1, max: 8 }] } }, output: ['LATENT'] },
  KSampler: { input: { required: {
    model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'],
    seed: ['INT', { min: 0 }], steps: ['INT', { min: 1, max: 100 }], cfg: ['FLOAT', { min: 0, max: 100 }],
    sampler_name: [['euler']], scheduler: [['normal']], denoise: ['FLOAT', { min: 0, max: 1 }],
  } }, output: ['LATENT'] },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'] },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: [], output_node: true },
};
