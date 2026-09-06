# Manual test workflows

These deterministic workflows exercise Comfy Mobile without loading a model:

1. `ManualTest_01_Image_Load_Save.json` reads the reusable `example.png` input and saves it.
2. `ManualTest_02_Image_Color_Batch.json` creates and saves a red/green/blue image batch.
3. `ManualTest_03_Video_MP4_Color.json` encodes six colored frames as H.264 MP4.
4. `ManualTest_04_Video_WEBM_Color.json` encodes six colored frames as VP9 WebM.

Expected outputs are written below `output/ManualTest/`. In the Android app, connect to the
Gateway, open the server workflow importer, search for `ManualTest_`, import a workflow, open it,
and tap Execute. Verify the result in the Images or Videos gallery and test Preview and Download.

The emulator preparation script also imports two model-backed workflows that already live on the
server: `图片_Z-Image_标准1024.json` for a real 1024px image generation and
`H3_文生视频_FL2VA_省显存LoRA_8步.json` for a real text-to-video run. They are intentionally not
auto-executed because they are the slower, GPU-intensive manual checks.

The deterministic public-Gateway smoke suite is `npm run test:e2e:manual`. To connect an Android
virtual device, import the workflows, exercise the four fast workflows through the actual App UI,
and leave the App ready for manual testing, run `npm run prepare:manual:android`. Both commands
require the corresponding Gateway token environment variable; neither command prints the token.
