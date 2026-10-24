/**
 * Controlled Real-Inference Smoke Test
 * Tests full path on real local hardware & MiniMax H3 model:
 * Prompt -> Plan -> ComfyUI live inference -> Scene output -> FFmpeg assembly -> FFprobe validation -> Review-ready job
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

const { ComfyUIClient } = require('./utils/comfyui-client');
const { WorkflowRegistry } = require('./utils/workflow-registry');
const { AIPlanner } = require('./utils/ai-planner');
const { ProductionAssembler } = require('./utils/production-assembler');
const { ProductionOrchestrator } = require('./agents/production-orchestrator');
const { Database } = require('./database/db');
const { Logger } = require('./utils/logger');

const logger = new Logger('RealInferenceSmokeTest');

async function runRealInferenceSmokeTest() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('🎬 Starting Real-Inference Smoke Test (MiniMax H3 Local)');
  console.log('════════════════════════════════════════════════════════════\n');

  const startTime = Date.now();

  // 1. Initialize components
  const db = new Database();
  await db.initialize();

  const comfy = new ComfyUIClient({ baseUrl: process.env.COMFYUI_URL || 'http://127.0.0.1:8188' });
  const registry = new WorkflowRegistry();
  const planner = new AIPlanner({ apiKey: process.env.GEMINI_API_KEY });
  const assembler = new ProductionAssembler();
  const orchestrator = new ProductionOrchestrator({ db, comfy, registry, planner, assembler });

  // 2. Pre-flight verification
  logger.info('Checking ComfyUI live connectivity...');
  const isAvailable = await comfy.isAvailable();
  if (!isAvailable) {
    throw new Error('ComfyUI server is NOT running on 127.0.0.1:8188. Start ComfyUI first.');
  }
  logger.success('ComfyUI server is online.');

  logger.info('Verifying MiniMax H3 local workflow and model files on disk...');
  const verifyRes = await registry.verifyWorkflow('minimax_h3_turbo_local');
  if (!verifyRes.available) {
    throw new Error(`Workflow verification failed: missing models ${JSON.stringify(verifyRes.missingModels)}`);
  }
  logger.success('MiniMax H3 models and custom nodes verified on disk.');

  // 3. Create isolated test job
  const prompt = 'Cinematic drone view of an ancient Dravidian granite temple tower at dawn';
  logger.info(`Creating isolated production test job for prompt: "${prompt}"...`);
  
  const createdJob = await orchestrator.createJob({
    prompt,
    format: 'cinematic',
    duration: 5, // 1 scene
    aspectRatio: '16:9',
    resolution: '1080p',
    workflowId: 'minimax_h3_turbo_local'
  });

  const jobId = createdJob.id;
  logger.success(`Created job ${jobId} (status: ${createdJob.status})`);

  // 4. Plan the job
  logger.info(`Generating production plan for ${jobId}...`);
  const planRes = await orchestrator.planJob(jobId, { allowTemplateFallback: true });
  logger.success(`Plan created: "${planRes.plan.title}" (${planRes.plan.scenes.length} scene)`);
  assert.strictEqual(planRes.plan.scenes.length, 1, 'Expected exactly 1 scene for 5s test duration');

  // 5. Run real local inference on ComfyUI with lowest practical frame count (22 frames)
  logger.info(`Starting real MiniMax H3 inference on local GPU (RTX 4070)...`);
  logger.info(`Using 22-frame pilot configuration (864x480 native base, 8-step turbo LoRA)...`);

  const genStartTime = Date.now();
  const genRes = await orchestrator.startGeneration(jobId, { clipFrames: 22 });
  const genElapsedSec = Math.round((Date.now() - genStartTime) / 1000);
  
  logger.success(`Generation and assembly completed in ${genElapsedSec}s (${(genElapsedSec / 60).toFixed(2)} min).`);

  // 6. Inspect and validate produced assets
  const jobDir = orchestrator.getJobDir(jobId);
  const masterFinalPath = path.join(jobDir, 'final', 'master_final.mp4');
  const thumbnailPath = path.join(jobDir, 'thumbnails', 'thumbnail_default.jpg');

  logger.info('Validating output files on disk...');
  assert.ok(fs.existsSync(masterFinalPath), `Final master video must exist: ${masterFinalPath}`);
  assert.ok(fs.existsSync(thumbnailPath), `Thumbnail must exist: ${thumbnailPath}`);

  const finalSize = fs.statSync(masterFinalPath).size;
  const thumbSize = fs.statSync(thumbnailPath).size;
  logger.info(`Master file size: ${(finalSize / 1024).toFixed(1)} KB (${finalSize} bytes)`);
  logger.info(`Thumbnail file size: ${(thumbSize / 1024).toFixed(1)} KB`);
  assert.ok(finalSize > 30000, `Final video must be non-trivial size (>30KB), got ${finalSize}`);

  // 7. FFprobe stream validation
  logger.info('Probing master video with FFprobe...');
  const probe = await assembler.probeMedia(masterFinalPath);
  logger.info(`FFprobe analysis:`);
  logger.info(`  Resolution: ${probe.width}x${probe.height}`);
  logger.info(`  Duration:   ${probe.duration.toFixed(2)}s`);
  logger.info(`  Video FPS:  ${probe.fps} fps (${probe.codec})`);
  logger.info(`  Audio:      ${probe.hasAudio ? `${probe.audioCodec} (${probe.audioSampleRate}Hz)` : 'None'}`);

  assert.strictEqual(probe.width, 1920, 'Master video width must be normalized to 1920 (16:9)');
  assert.strictEqual(probe.height, 1080, 'Master video height must be normalized to 1080 (16:9)');
  assert.ok(probe.duration > 0.5, `Duration must be valid (>0.5s), got ${probe.duration}`);
  assert.strictEqual(probe.hasAudio, true, 'Master video must contain a valid audio stream');

  // 8. Verify SQLite pipeline staging
  logger.info('Verifying SQLite pipeline status...');
  const dbJob = await db.getGenerationJob(jobId);
  logger.info(`Job status in DB: ${dbJob.status}, stage: ${dbJob.stage}, progress: ${dbJob.progress}%`);
  assert.strictEqual(dbJob.status, 'awaiting_approval', 'Job must reach awaiting_approval status');

  const reviewRows = await db.getAllRows(
    `SELECT * FROM content_reviews WHERE production_id = ?`,
    [jobId]
  );
  assert.ok(reviewRows && reviewRows.length > 0, 'Content review record must exist in content_reviews');
  logger.success(`Content review staged in SQLite with status: "${reviewRows[0].status}"`);

  // 9. Verify publishing guardrail: Private default & approval required
  logger.info('Verifying publishing safety guardrail...');
  let approvalBlocked = false;
  try {
    // Attempting upload without explicit publishing agent should fail safely
    await orchestrator.approveAndPublish(jobId, null);
  } catch (e) {
    approvalBlocked = true;
  }
  assert.strictEqual(approvalBlocked, true, 'Upload must require explicit approval and publishingAgent');
  logger.success('Publishing safeguard verified: no automatic/unapproved upload occurred.');

  const totalElapsedSec = Math.round((Date.now() - startTime) / 1000);

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('🎉 REAL-INFERENCE SMOKE TEST SUMMARY');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`Job ID:            ${jobId}`);
  console.log(`Prompt:            "${prompt}"`);
  console.log(`Model:             MiniMax H3 W6A8 + 8-step Turbo LoRA (Local RTX 4070)`);
  console.log(`Inference Frames:  22 frames (864x480 native base)`);
  console.log(`Inference Runtime: ${genElapsedSec}s (${(genElapsedSec / 60).toFixed(2)} min)`);
  console.log(`Total Runtime:     ${totalElapsedSec}s (${(totalElapsedSec / 60).toFixed(2)} min)`);
  console.log(`Output Master:     ${masterFinalPath}`);
  console.log(`Normalized Spec:   1920x1080 @ 24fps (16:9 Widescreen)`);
  console.log(`Duration:          ${probe.duration.toFixed(2)}s`);
  console.log(`Audio Stream:      ${probe.audioCodec} (${probe.audioSampleRate} Hz)`);
  console.log(`File Size:         ${(finalSize / 1024 / 1024).toFixed(2)} MB (${finalSize} bytes)`);
  console.log(`Pipeline Status:   awaiting_approval (Staged in SQLite, ready for review)`);
  console.log(`Publishing Status: Guarded (Private default, awaiting operator approval)`);
  console.log('════════════════════════════════════════════════════════════\n');

  return {
    success: true,
    jobId,
    runtimeSeconds: genElapsedSec,
    dimensions: `${probe.width}x${probe.height}`,
    duration: probe.duration,
    fileSizeBytes: finalSize,
    audioCodec: probe.audioCodec,
    status: dbJob.status
  };
}

runRealInferenceSmokeTest()
  .then(res => {
    fs.writeFileSync(
      path.join(__dirname, 'data', 'smoke_test_result.json'),
      JSON.stringify(res, null, 2),
      'utf8'
    );
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Smoke Test Failed:', err);
    process.exit(1);
  });
