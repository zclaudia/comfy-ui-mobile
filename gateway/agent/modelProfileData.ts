// Reviewed against ai-server reference workflows; no user reference media is bundled.
export const modelProfileData = [
  {
    "id": "z-image-turbo",
    "source": "图片_Z-Image_标准1024.json",
    "media": "image",
    "prompt": {
      "1": {
        "class_type": "UNETLoader",
        "inputs": {
          "unet_name": "z_image_turbo_bf16.safetensors",
          "weight_dtype": "default"
        }
      },
      "2": {
        "class_type": "CLIPLoader",
        "inputs": {
          "clip_name": "qwen_3_4b.safetensors",
          "type": "lumina2",
          "device": "default"
        }
      },
      "3": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "ae.safetensors"
        }
      },
      "4": {
        "class_type": "ModelSamplingAuraFlow",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "shift": 3
        }
      },
      "5": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "clip": [
            "2",
            0
          ],
          "text": "A cinematic landscape at sunrise"
        }
      },
      "6": {
        "class_type": "ConditioningZeroOut",
        "inputs": {
          "conditioning": [
            "5",
            0
          ]
        }
      },
      "7": {
        "class_type": "EmptySD3LatentImage",
        "inputs": {
          "width": 1024,
          "height": 1024,
          "batch_size": 1
        }
      },
      "8": {
        "class_type": "KSampler",
        "inputs": {
          "model": [
            "4",
            0
          ],
          "positive": [
            "5",
            0
          ],
          "negative": [
            "6",
            0
          ],
          "latent_image": [
            "7",
            0
          ],
          "seed": 2024,
          "steps": 8,
          "cfg": 1,
          "sampler_name": "res_multistep",
          "scheduler": "simple",
          "denoise": 1
        }
      },
      "9": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "8",
            0
          ],
          "vae": [
            "3",
            0
          ]
        }
      },
      "10": {
        "class_type": "SaveImage",
        "inputs": {
          "images": [
            "9",
            0
          ],
          "filename_prefix": "ComfyMobile/Agent/z-image-turbo"
        }
      }
    }
  },
  {
    "id": "z-image-turbo-hires",
    "source": "图片_Z-Image_高分辨率2048.json",
    "media": "image",
    "prompt": {
      "1": {
        "class_type": "UNETLoader",
        "inputs": {
          "unet_name": "z_image_turbo_bf16.safetensors",
          "weight_dtype": "default"
        }
      },
      "2": {
        "class_type": "CLIPLoader",
        "inputs": {
          "clip_name": "qwen_3_4b.safetensors",
          "type": "lumina2",
          "device": "default"
        }
      },
      "3": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "ae.safetensors"
        }
      },
      "4": {
        "class_type": "ModelSamplingAuraFlow",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "shift": 3
        }
      },
      "5": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "clip": [
            "2",
            0
          ],
          "text": "A cinematic landscape at sunrise"
        }
      },
      "6": {
        "class_type": "ConditioningZeroOut",
        "inputs": {
          "conditioning": [
            "5",
            0
          ]
        }
      },
      "7": {
        "class_type": "EmptySD3LatentImage",
        "inputs": {
          "width": 2048,
          "height": 1152,
          "batch_size": 1
        }
      },
      "8": {
        "class_type": "KSampler",
        "inputs": {
          "model": [
            "4",
            0
          ],
          "positive": [
            "5",
            0
          ],
          "negative": [
            "6",
            0
          ],
          "latent_image": [
            "7",
            0
          ],
          "seed": 7,
          "steps": 8,
          "cfg": 1,
          "sampler_name": "res_multistep",
          "scheduler": "simple",
          "denoise": 1
        }
      },
      "9": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "8",
            0
          ],
          "vae": [
            "3",
            0
          ]
        }
      },
      "10": {
        "class_type": "SaveImage",
        "inputs": {
          "images": [
            "9",
            0
          ],
          "filename_prefix": "ComfyMobile/Agent/z-image-turbo-hires"
        }
      }
    }
  },
  {
    "id": "z-image-turbo-img2img",
    "source": "图片_Z-Image_标准1024.json + LoadImage/VAEEncode img2img chain",
    "media": "image",
    "reference": "referenceImage",
    "description": "Z-Image Turbo image-to-image: restyles or edits the user-selected referenceImage while keeping its composition. Output resolution follows the reference (scaled to ~1MP), so ignore width/height. Set denoise 0.30-0.45 for light retouching, 0.55-0.65 to refine while keeping the current look, 0.75-0.85 for a full style change such as photo to watercolor or anime (8-step CFG-1 keeps the base below that); omit it for the balanced default. For pure text-to-image with no reference, use z-image-turbo instead.",
    "prompt": {
      "1": {
        "class_type": "UNETLoader",
        "inputs": {
          "unet_name": "z_image_turbo_bf16.safetensors",
          "weight_dtype": "default"
        }
      },
      "2": {
        "class_type": "CLIPLoader",
        "inputs": {
          "clip_name": "qwen_3_4b.safetensors",
          "type": "lumina2",
          "device": "default"
        }
      },
      "3": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "ae.safetensors"
        }
      },
      "4": {
        "class_type": "ModelSamplingAuraFlow",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "shift": 3
        }
      },
      "5": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "clip": [
            "2",
            0
          ],
          "text": "A cinematic landscape at sunrise"
        }
      },
      "6": {
        "class_type": "ConditioningZeroOut",
        "inputs": {
          "conditioning": [
            "5",
            0
          ]
        }
      },
      "17": {
        "class_type": "LoadImage",
        "inputs": {
          "image": "__reference_required__"
        }
      },
      "18": {
        "class_type": "ImageScaleToTotalPixels",
        "inputs": {
          "image": [
            "17",
            0
          ],
          "upscale_method": "lanczos",
          "megapixels": 1.0,
          "resolution_steps": 1
        }
      },
      "7": {
        "class_type": "VAEEncode",
        "inputs": {
          "pixels": [
            "18",
            0
          ],
          "vae": [
            "3",
            0
          ]
        }
      },
      "8": {
        "class_type": "KSampler",
        "inputs": {
          "model": [
            "4",
            0
          ],
          "positive": [
            "5",
            0
          ],
          "negative": [
            "6",
            0
          ],
          "latent_image": [
            "7",
            0
          ],
          "seed": 2024,
          "steps": 8,
          "cfg": 1,
          "sampler_name": "res_multistep",
          "scheduler": "simple",
          "denoise": 0.55
        }
      },
      "9": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "8",
            0
          ],
          "vae": [
            "3",
            0
          ]
        }
      },
      "10": {
        "class_type": "SaveImage",
        "inputs": {
          "images": [
            "9",
            0
          ],
          "filename_prefix": "ComfyMobile/Agent/z-image-turbo-img2img"
        }
      }
    }
  },
  {
    "id": "h3-fl2va",
    "source": "H3_文生视频_FL2VA_官方LoRA_8步.json",
    "media": "video",
    "prompt": {
      "1": {
        "class_type": "UnetLoaderGGUF",
        "inputs": {
          "unet_name": "MiniMax-H3-FL2VA-Pruned-Q5_K_M.gguf"
        }
      },
      "2": {
        "class_type": "CLIPLoaderGGUF",
        "inputs": {
          "clip_name": "qwen3vl_32b_minimax_h3-Q4_K_M.gguf",
          "type": "minimax"
        }
      },
      "3": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "minimax_h3_video_vae_fp16.safetensors"
        }
      },
      "4": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "minimax_h3_audio_vae_fp32.safetensors"
        }
      },
      "5": {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "lora_name": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
          "strength_model": 1
        }
      },
      "6": {
        "class_type": "MiniMaxH3SigmaShift",
        "inputs": {
          "model": [
            "5",
            0
          ],
          "shift_video": 12,
          "shift_audio": 6
        }
      },
      "7": {
        "class_type": "MiniMaxH3ImageToVideo",
        "inputs": {
          "clip": [
            "2",
            0
          ],
          "vae": [
            "3",
            0
          ],
          "prompt": "A cinematic landscape at sunrise with gentle wind",
          "width": 864,
          "height": 480,
          "length": 22
        }
      },
      "8": {
        "class_type": "BasicGuider",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "conditioning": [
            "7",
            0
          ]
        }
      },
      "9": {
        "class_type": "BasicScheduler",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "scheduler": "simple",
          "steps": 8,
          "denoise": 1
        }
      },
      "10": {
        "class_type": "KSamplerSelect",
        "inputs": {
          "sampler_name": "res_multistep"
        }
      },
      "11": {
        "class_type": "RandomNoise",
        "inputs": {
          "noise_seed": 42
        }
      },
      "12": {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
          "noise": [
            "11",
            0
          ],
          "guider": [
            "8",
            0
          ],
          "sampler": [
            "10",
            0
          ],
          "sigmas": [
            "9",
            0
          ],
          "latent_image": [
            "7",
            1
          ]
        }
      },
      "13": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "12",
            0
          ],
          "vae": [
            "3",
            0
          ]
        }
      },
      "14": {
        "class_type": "VAEDecodeAudio",
        "inputs": {
          "samples": [
            "12",
            0
          ],
          "vae": [
            "4",
            0
          ]
        }
      },
      "15": {
        "class_type": "CreateVideo",
        "inputs": {
          "images": [
            "13",
            0
          ],
          "audio": [
            "14",
            0
          ],
          "fps": 24
        }
      },
      "16": {
        "class_type": "SaveVideo",
        "inputs": {
          "video": [
            "15",
            0
          ],
          "filename_prefix": "ComfyMobile/Agent/h3-fl2va",
          "format": "auto",
          "codec": "auto"
        }
      }
    }
  },
  {
    "id": "h3-fl2va-lite",
    "source": "H3_文生视频_FL2VA_省显存LoRA_8步.json",
    "media": "video",
    "prompt": {
      "1": {
        "class_type": "UnetLoaderGGUF",
        "inputs": {
          "unet_name": "MiniMax-H3-FL2VA-Pruned-Q5_K_M.gguf"
        }
      },
      "2": {
        "class_type": "CLIPLoaderGGUF",
        "inputs": {
          "clip_name": "qwen3vl_32b_minimax_h3-Q4_K_M.gguf",
          "type": "minimax"
        }
      },
      "3": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "minimax_h3_video_vae_fp16.safetensors"
        }
      },
      "4": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "minimax_h3_audio_vae_fp32.safetensors"
        }
      },
      "5": {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "lora_name": "minimax_h3_turbo_4step_ckpt600_ema_V4.safetensors",
          "strength_model": 1
        }
      },
      "6": {
        "class_type": "MiniMaxH3SigmaShift",
        "inputs": {
          "model": [
            "5",
            0
          ],
          "shift_video": 12,
          "shift_audio": 6
        }
      },
      "7": {
        "class_type": "MiniMaxH3ImageToVideo",
        "inputs": {
          "clip": [
            "2",
            0
          ],
          "vae": [
            "3",
            0
          ],
          "prompt": "A cinematic landscape at sunrise with gentle wind",
          "width": 864,
          "height": 480,
          "length": 22
        }
      },
      "8": {
        "class_type": "BasicGuider",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "conditioning": [
            "7",
            0
          ]
        }
      },
      "9": {
        "class_type": "BasicScheduler",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "scheduler": "simple",
          "steps": 8,
          "denoise": 1
        }
      },
      "10": {
        "class_type": "KSamplerSelect",
        "inputs": {
          "sampler_name": "res_multistep"
        }
      },
      "11": {
        "class_type": "RandomNoise",
        "inputs": {
          "noise_seed": 42
        }
      },
      "12": {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
          "noise": [
            "11",
            0
          ],
          "guider": [
            "8",
            0
          ],
          "sampler": [
            "10",
            0
          ],
          "sigmas": [
            "9",
            0
          ],
          "latent_image": [
            "7",
            1
          ]
        }
      },
      "13": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "12",
            0
          ],
          "vae": [
            "3",
            0
          ]
        }
      },
      "14": {
        "class_type": "VAEDecodeAudio",
        "inputs": {
          "samples": [
            "12",
            0
          ],
          "vae": [
            "4",
            0
          ]
        }
      },
      "15": {
        "class_type": "CreateVideo",
        "inputs": {
          "images": [
            "13",
            0
          ],
          "audio": [
            "14",
            0
          ],
          "fps": 24
        }
      },
      "16": {
        "class_type": "SaveVideo",
        "inputs": {
          "video": [
            "15",
            0
          ],
          "filename_prefix": "ComfyMobile/Agent/h3-fl2va-lite",
          "format": "auto",
          "codec": "auto"
        }
      }
    }
  },
  {
    "id": "h3-ref-image",
    "source": "H3_参考驱动_Ref2VA_4步.json",
    "media": "video",
    "reference": "referenceImage",
    "prompt": {
      "1": {
        "class_type": "UnetLoaderGGUF",
        "inputs": {
          "unet_name": "MiniMax-H3-Ref2VA-Pruned-Q5_K_M.gguf"
        }
      },
      "2": {
        "class_type": "CLIPLoaderGGUF",
        "inputs": {
          "clip_name": "qwen3vl_32b_minimax_h3-Q4_K_M.gguf",
          "type": "minimax"
        }
      },
      "3": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "minimax_h3_video_vae_fp16.safetensors"
        }
      },
      "4": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "minimax_h3_audio_vae_fp32.safetensors"
        }
      },
      "5": {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
          "strength_model": 1
        }
      },
      "6": {
        "class_type": "MiniMaxH3SigmaShift",
        "inputs": {
          "model": [
            "5",
            0
          ],
          "shift_video": 12,
          "shift_audio": 6
        }
      },
      "7": {
        "class_type": "MiniMaxH3ReferenceToVideo",
        "inputs": {
          "clip": [
            "2",
            0
          ],
          "vae": [
            "3",
            0
          ],
          "audio_vae": [
            "4",
            0
          ],
          "ref_images.ref_image_0": [
            "17",
            0
          ],
          "prompt": "A cinematic landscape at sunrise with gentle wind",
          "width": 864,
          "height": 480,
          "length": 22,
          "ref_image_size": "match"
        }
      },
      "8": {
        "class_type": "BasicGuider",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "conditioning": [
            "7",
            0
          ]
        }
      },
      "9": {
        "class_type": "BasicScheduler",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "scheduler": "simple",
          "steps": 4,
          "denoise": 1
        }
      },
      "10": {
        "class_type": "KSamplerSelect",
        "inputs": {
          "sampler_name": "res_multistep"
        }
      },
      "11": {
        "class_type": "RandomNoise",
        "inputs": {
          "noise_seed": 4242
        }
      },
      "12": {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
          "noise": [
            "11",
            0
          ],
          "guider": [
            "8",
            0
          ],
          "sampler": [
            "10",
            0
          ],
          "sigmas": [
            "9",
            0
          ],
          "latent_image": [
            "7",
            1
          ]
        }
      },
      "13": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "12",
            0
          ],
          "vae": [
            "3",
            0
          ]
        }
      },
      "14": {
        "class_type": "VAEDecodeAudio",
        "inputs": {
          "samples": [
            "12",
            0
          ],
          "vae": [
            "4",
            0
          ]
        }
      },
      "15": {
        "class_type": "CreateVideo",
        "inputs": {
          "images": [
            "13",
            0
          ],
          "audio": [
            "14",
            0
          ],
          "fps": 24
        }
      },
      "16": {
        "class_type": "SaveVideo",
        "inputs": {
          "video": [
            "15",
            0
          ],
          "filename_prefix": "ComfyMobile/Agent/h3-ref-image",
          "format": "auto",
          "codec": "auto"
        }
      },
      "17": {
        "class_type": "LoadImage",
        "inputs": {
          "image": "__reference_required__"
        }
      }
    }
  },
  {
    "id": "h3-ref-audio",
    "source": "H3_参考驱动_Ref2VA_独立参考音频.json",
    "media": "video",
    "reference": "referenceAudio",
    "prompt": {
      "1": {
        "class_type": "UnetLoaderGGUF",
        "inputs": {
          "unet_name": "MiniMax-H3-Ref2VA-Pruned-Q5_K_M.gguf"
        }
      },
      "2": {
        "class_type": "CLIPLoaderGGUF",
        "inputs": {
          "clip_name": "qwen3vl_32b_minimax_h3-Q4_K_M.gguf",
          "type": "minimax"
        }
      },
      "3": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "minimax_h3_video_vae_fp16.safetensors"
        }
      },
      "4": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "minimax_h3_audio_vae_fp32.safetensors"
        }
      },
      "5": {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
          "strength_model": 1
        }
      },
      "6": {
        "class_type": "MiniMaxH3SigmaShift",
        "inputs": {
          "model": [
            "5",
            0
          ],
          "shift_video": 12,
          "shift_audio": 6
        }
      },
      "7": {
        "class_type": "MiniMaxH3ReferenceToVideo",
        "inputs": {
          "clip": [
            "2",
            0
          ],
          "vae": [
            "3",
            0
          ],
          "audio_vae": [
            "4",
            0
          ],
          "ref_audios.ref_audio_0": [
            "17",
            0
          ],
          "prompt": "A cinematic landscape at sunrise with gentle wind",
          "width": 864,
          "height": 480,
          "length": 22,
          "ref_image_size": "match"
        }
      },
      "8": {
        "class_type": "BasicGuider",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "conditioning": [
            "7",
            0
          ]
        }
      },
      "9": {
        "class_type": "BasicScheduler",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "scheduler": "simple",
          "steps": 4,
          "denoise": 1
        }
      },
      "10": {
        "class_type": "KSamplerSelect",
        "inputs": {
          "sampler_name": "res_multistep"
        }
      },
      "11": {
        "class_type": "RandomNoise",
        "inputs": {
          "noise_seed": 777
        }
      },
      "12": {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
          "noise": [
            "11",
            0
          ],
          "guider": [
            "8",
            0
          ],
          "sampler": [
            "10",
            0
          ],
          "sigmas": [
            "9",
            0
          ],
          "latent_image": [
            "7",
            1
          ]
        }
      },
      "13": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "12",
            0
          ],
          "vae": [
            "3",
            0
          ]
        }
      },
      "14": {
        "class_type": "VAEDecodeAudio",
        "inputs": {
          "samples": [
            "12",
            0
          ],
          "vae": [
            "4",
            0
          ]
        }
      },
      "15": {
        "class_type": "CreateVideo",
        "inputs": {
          "images": [
            "13",
            0
          ],
          "audio": [
            "14",
            0
          ],
          "fps": 24
        }
      },
      "16": {
        "class_type": "SaveVideo",
        "inputs": {
          "video": [
            "15",
            0
          ],
          "filename_prefix": "ComfyMobile/Agent/h3-ref-audio",
          "format": "auto",
          "codec": "auto"
        }
      },
      "17": {
        "class_type": "LoadAudio",
        "inputs": {
          "audio": "__reference_required__"
        }
      }
    }
  },
  {
    "id": "h3-ref-video",
    "source": "H3_参考驱动_Ref2VA_参考视频+音轨.json",
    "media": "video",
    "reference": "referenceVideo",
    "prompt": {
      "1": {
        "class_type": "UnetLoaderGGUF",
        "inputs": {
          "unet_name": "MiniMax-H3-Ref2VA-Pruned-Q5_K_M.gguf"
        }
      },
      "2": {
        "class_type": "CLIPLoaderGGUF",
        "inputs": {
          "clip_name": "qwen3vl_32b_minimax_h3-Q4_K_M.gguf",
          "type": "minimax"
        }
      },
      "3": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "minimax_h3_video_vae_fp16.safetensors"
        }
      },
      "4": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "minimax_h3_audio_vae_fp32.safetensors"
        }
      },
      "5": {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
          "model": [
            "1",
            0
          ],
          "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
          "strength_model": 1
        }
      },
      "6": {
        "class_type": "MiniMaxH3SigmaShift",
        "inputs": {
          "model": [
            "5",
            0
          ],
          "shift_video": 12,
          "shift_audio": 6
        }
      },
      "7": {
        "class_type": "MiniMaxH3ReferenceToVideo",
        "inputs": {
          "clip": [
            "2",
            0
          ],
          "vae": [
            "3",
            0
          ],
          "audio_vae": [
            "4",
            0
          ],
          "ref_videos.ref_video_0": [
            "18",
            0
          ],
          "ref_video_audios.ref_video_audio_0": [
            "18",
            1
          ],
          "prompt": "A cinematic landscape at sunrise with gentle wind",
          "width": 864,
          "height": 480,
          "length": 22,
          "ref_image_size": "match"
        }
      },
      "8": {
        "class_type": "BasicGuider",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "conditioning": [
            "7",
            0
          ]
        }
      },
      "9": {
        "class_type": "BasicScheduler",
        "inputs": {
          "model": [
            "6",
            0
          ],
          "scheduler": "simple",
          "steps": 4,
          "denoise": 1
        }
      },
      "10": {
        "class_type": "KSamplerSelect",
        "inputs": {
          "sampler_name": "res_multistep"
        }
      },
      "11": {
        "class_type": "RandomNoise",
        "inputs": {
          "noise_seed": 777
        }
      },
      "12": {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
          "noise": [
            "11",
            0
          ],
          "guider": [
            "8",
            0
          ],
          "sampler": [
            "10",
            0
          ],
          "sigmas": [
            "9",
            0
          ],
          "latent_image": [
            "7",
            1
          ]
        }
      },
      "13": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": [
            "12",
            0
          ],
          "vae": [
            "3",
            0
          ]
        }
      },
      "14": {
        "class_type": "VAEDecodeAudio",
        "inputs": {
          "samples": [
            "12",
            0
          ],
          "vae": [
            "4",
            0
          ]
        }
      },
      "15": {
        "class_type": "CreateVideo",
        "inputs": {
          "images": [
            "13",
            0
          ],
          "audio": [
            "14",
            0
          ],
          "fps": 24
        }
      },
      "16": {
        "class_type": "SaveVideo",
        "inputs": {
          "video": [
            "15",
            0
          ],
          "filename_prefix": "ComfyMobile/Agent/h3-ref-video",
          "format": "auto",
          "codec": "auto"
        }
      },
      "17": {
        "class_type": "LoadVideo",
        "inputs": {
          "file": "__reference_required__"
        }
      },
      "18": {
        "class_type": "GetVideoComponents",
        "inputs": {
          "video": [
            "17",
            0
          ]
        }
      }
    }
  }
] as const;
