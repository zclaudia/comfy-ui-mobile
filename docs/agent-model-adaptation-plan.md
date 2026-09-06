# Z-Image / MiniMax H3 Agent 适配实施计划

## 目标与顺序

1. 以服务器已有的 2 条 Z-Image 与 5 条 H3 画布为参考，核对实际节点 schema、模型文件和参数布局；保留原工作流，只操作副本。
2. 扩展显式节点 codec：独立模型/编码器/VAE、基础及高级采样器、H3 文本/参考输入、视频/音频输出。兼容带/不带 seed 控制控件的旧画布；说明节点保留但不执行。
3. 增加模型模板目录、环境能力清单、缺失资源诊断及模板创建工具。先支持 Z-Image，再支持 H3 FL2VA、Ref2VA 的图片/音频/视频参考。参考素材必须显式提供，不擅自使用用户已有素材。
4. 支持动态 COMBO 与 H3 参考槽验证；固定已核对的模型组合与采样默认值，限制测试预览的尺寸/帧数，保持版本事务和恢复行为。
5. Agent 结果支持图片、视频、音频，沿用原生鉴权媒体加载；长任务继续沿用后台轮询、取消和防重复提交机制。
6. 验证：所有参考画布导入/修改/往返测试、模板缺失资源/参考参数测试、真实 Z-Image 和 H3 生成、真实 LLM 模板选择与执行、Android 虚拟机结果播放和画布打开。

## 验收

- 自然语言选择已安装模型，创建正确工作流，真实出图/出视频并保存。
- 模板所需模型缺失或参考输入缺失时明确诊断，不用其他模型冒充。
- 修改提示词、种子、尺寸和帧数能正确写回画布；说明/布局不丢失。
- 参考型模板仅使用显式传入的图片、音频或视频。
- 多媒体通过 Gateway 鉴权读取，虚拟机可播放视频；只清理测试设备凭据。
- 测试资源使用 ComfyMobileE2E 前缀，不下载/安装新模型，不修改服务器原有模型或参考工作流。

## 已确认环境

RTX 3080 20GB；Z-Image Turbo bf16 + Qwen3 4B + ae；H3 FL2VA Q5/Q6、Ref2VA Q5、Qwen3VL 32B GGUF、视频/音频 VAE 和三种 LoRA。参考工作流中的备注仅作为线索，实际运行结果另行记录。

## 实现内容

- `gateway/workflow/canvas.ts`：扩展明确的节点布局，兼容旧 KSampler，保留说明节点。
- `gateway/workflow/engine.ts`：V3 COMBO/autogrow 校验、H3 尺寸与帧数约束。
- `gateway/agent/modelProfileData.ts`、`modelProfiles.ts`：七个已核对模板、可用性诊断、参数和显式参考文件。
- `create_model_workflow` 工具：根据模板创建版本；原有修改、预览、保存、恢复继续复用。
- `gateway/agent/media.ts`、`AgentMedia.tsx`：识别并鉴权展示图片、视频和音频。
- 38 项 Agent/工作流回归通过，7 个参考画布往返和所有模型模板创建均覆盖。

## 真实 GPU 验收（已完成）

| 模板 | 输出 | 本轮耗时 |
|---|---|---|
| Z-Image 标准 | 1024×1024 PNG | 18 秒 |
| Z-Image 高分辨率 | 2048×1152 PNG | 24 秒 |
| H3 FL2VA 官方 LoRA | 864×480 / 22 帧，H.264 + AAC | 56 秒 |
| H3 FL2VA 省显存 LoRA | 同上 | 45 秒 |
| H3 Ref2VA 图片参考 | 同上 | 39 秒 |
| H3 Ref2VA 音频参考 | 同上 | 39 秒 |
| H3 Ref2VA 视频和音轨参考 | 同上 | 43 秒 |

耗时包含提交、排队、模型加载、生成和取回，不是独立性能基准。参考素材为程序生成的
色块、正弦音和短视频，未使用用户的私人图片、音频或视频。

证据：`tests/output/model-adaptation/9ee799fa-2cdb-44ef-9312-251ff1dd15e7/report.json`，
同目录保存输入画布、执行历史、图片/视频及 ffprobe 检查结果。

## 使用与限制

可以直接说：“用 Z-Image 生成一张湖上纸船的图片，试跑并保存”，或“用 H3 生成
864×480、22 帧的湖面短视频，试跑并保存”。参考型生成需先在现有上传入口上传素材，
再明确告诉助手文件名。聊天页目前没有单独的附件上传按钮。

支持已核对的模型组合和现有节点参数修改，尚不支持随意增删节点、子图及复杂视频
重编码控件。H3 默认约 0.92 秒的短片用于可控预览，长视频质量和显存边界需另行验证。

H3 FL2VA 的 Q6 分支也已单独实跑：省显存 LoRA / 22 帧，57 秒，H.264 视频与 AAC
音轨均通过检查。证据：`tests/output/model-adaptation/0cca428a-2bdf-4069-ae5c-c184065d9729/report.json`。

复跑方式（密钥通过安全环境注入）：

```sh
npm run build:agent
E2E_MODELS_LIVE=1 npm run test:e2e:models
E2E_AGENT_LIVE=1 E2E_AGENT_MODELS=1 EMULATOR_SERIAL=emulator-5554 npm run test:e2e:android
```

两种真实测试都读取 `E2E_GATEWAY_TOKEN` 和可选的 `E2E_GATEWAY_URL`。前者会顺序运行
七个 GPU 模板；可用 `TEST_PROFILE_IDS=h3-fl2va-lite TEST_MODEL_VARIANT=q6` 单独验证变体。

## 最终交付验收

- Gateway 已部署到 ai-server，服务器 `.env` 校验保持不变。
- 新 Android 调试 APK 已安装到 emulator-5554。
- Android 全套 **22/22 通过**：包含原有 Agent 多轮/恢复用例，及真实 LLM 创建
  Z-Image、H3 模板 → 实际生成 → 图片显示/视频播放 → 保存 → 打开画布。
- H3 播放器验证 864×480、时长大于 0、播放时间推进；视频音轨由 GPU 用例的
  ffprobe 验证为 AAC。
- `tests/output/agent-models-android/report.json` 和同目录截图/对话记录保留证据。
- Agent/工作流回归 **38/38**、Gateway 回归 **4/4**、Web 与 Android 构建通过。
- 测试只操作 Android 虚拟机；本轮测试设备凭据已清理，未操作实体手机。
