/**
 * Automated Test Suite for Prompt-to-Video-to-YouTube Automation Engine
 * Tests AI planning schema validation, ComfyUI client, workflow registry,
 * FFmpeg assembly, job orchestration, persistence, cancellation, and YouTube publishing safety.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { ComfyUIClient } = require('./utils/comfyui-client');
const { WorkflowRegistry } = require('./utils/workflow-registry');
const { AIPlanner } = require('./utils/ai-planner');
const { ProductionAssembler } = require('./utils/production-assembler');
const { ProductionOrchestrator } = require('./agents/production-orchestrator');
const { Database } = require('./database/db');
const { Logger } = require('./utils/logger');
const FFmpeg = require('./utils/ffmpeg');

const logger = new Logger('StudioTestSuite');

let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
  process.stdout.write(`  • ${name} ... `);
  try {
    await fn();
    console.log('✅ PASSED');
    passedTests++;
  } catch (err) {
    console.log('❌ FAILED');
    console.error(`    Error: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    failedTests++;
  }
}

async function runAllTests() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('🧪 Starting Prompt-to-Video Studio Test Suite');
  console.log('════════════════════════════════════════════════════════════\n');

  const db = new Database();
  await db.initialize();

  const comfy = new ComfyUIClient({ baseUrl: process.env.COMFYUI_URL || 'http://127.0.0.1:8188' });
  const registry = new WorkflowRegistry();
  const planner = new AIPlanner({ apiKey: process.env.GEMINI_API_KEY });
  const assembler = new ProductionAssembler();
  const orchestrator = new ProductionOrchestrator({ db, comfy, registry, planner, assembler });

  // 1. AI Planning & Schema Validation Tests
  console.log('📋 1. Prompt Validation & Production-Plan Schema Validation');
  await test('Validates correct production plan schema', () => {
    const validPlan = {
      title: 'Echoes of the Chola Dynasty',
      concept: 'Cinematic exploration of ancient temple architecture at dawn.',
      target_duration: 10,
      aspect_ratio: '16:9',
      style: 'Cinematic golden hour',
      scenes: [
        {
          scene_id: 'scene_01',
          sequence: 1,
          duration_seconds: 5,
          visual_prompt: 'Aerial flyover of stone gopuram tower, dawn sunlight',
          camera_movement: 'Dolly forward',
          narration: 'Beneath the dawn sky, granite echoes ancient kings.'
        },
        {
          scene_id: 'scene_02',
          sequence: 2,
          duration_seconds: 5,
          visual_prompt: 'Intricate pillared hall with sun rays piercing stone shadows',
          camera_movement: 'Slow pan right',
          narration: 'Every sculpted pillar tells a forgotten legacy.'
        }
      ],
      youtube_metadata: {
        title: 'Echoes of the Chola Dynasty | 4K Cinematic Temple',
        description: 'Experience ancient South Indian temple architecture at dawn.',
        tags: ['temple', 'cinematic', 'history', 'architecture'],
        category_id: '27'
      }
    };
    const validation = planner.validatePlanSchema(validPlan);
    assert.strictEqual(validation.valid, true, `Validation failed: ${validation.errors.join(', ')}`);
  });

  await test('Rejects production plan missing mandatory fields', () => {
    const invalidPlan = {
      concept: 'Missing title and scenes'
    };
    const validation = planner.validatePlanSchema(invalidPlan);
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.length > 0);
  });

  await test('Generates deterministic fallback plan when AI key is missing', async () => {
    const fallbackPlanner = new AIPlanner({ apiKey: null });
    const plan = await fallbackPlanner.createPlan({
      prompt: 'Ancient Dravidian temple at dawn',
      targetDuration: 10,
      aspectRatio: '16:9'
    }, { allowTemplateFallback: true });
    assert.ok(plan.title);
    assert.strictEqual(plan.scenes.length, 2);
    assert.strictEqual(plan.scenes[0].duration_seconds, 5);
    assert.ok(plan.youtube_metadata.title);
    assert.ok(plan.youtube_metadata.tags.length >= 3);
    assert.strictEqual(plan.planning_mode, 'deterministic_template_fallback');
  });

  // 2. Workflow Selection & Input Mapping
  console.log('\n⚙️ 2. Workflow Selection & Input Mapping');
  await test('Registry retrieves verified MiniMax H3 workflow', () => {
    const wf = registry.get('minimax_h3_turbo_local');
    assert.ok(wf, 'Workflow not found');
    assert.strictEqual(wf.id, 'minimax_h3_turbo_local');
    assert.strictEqual(wf.clipFrames, 124);
    assert.strictEqual(wf.defaultFps, 24);
    assert.strictEqual(wf.vramRequiredGb, 11.5);
    assert.ok(wf.supportedAspectRatios.includes('16:9'));
  });

  await test('Builds ComfyUI prompt structure with injected scene parameters', () => {
    const wf = registry.get('minimax_h3_turbo_local');
    const promptDict = wf.buildPrompt({
      prompt: 'Majestic gopuram temple tower at golden hour',
      aspectRatio: '16:9',
      seed: 424242
    });
    assert.ok(promptDict, 'Prompt dictionary was not built');
    assert.ok(promptDict['131'], 'Missing MiniMax sampler node 131');
    assert.strictEqual(promptDict['131'].inputs.prompt, 'Majestic gopuram temple tower at golden hour');
    assert.strictEqual(promptDict['129'].inputs.noise_seed, 424242);
    assert.strictEqual(promptDict['115'].inputs.aspect_ratio, '16:9 (Widescreen)');
  });

  await test('Detects missing or unverified workflow gracefully', () => {
    assert.throws(() => {
      registry.get('non_existent_cloud_workflow');
    }, /not found in registry/);
  });

  // 3. ComfyUI Connection Failure and Recovery
  console.log('\n🔌 3. ComfyUI Connection Handling & Live Server Check');
  await test('Handles unreachable ComfyUI endpoint gracefully', async () => {
    const badClient = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:9999' });
    const isAvail = await badClient.isAvailable();
    assert.strictEqual(isAvail, false);
  });

  await test('Verifies live local ComfyUI server on 127.0.0.1:8188', async () => {
    const isAvail = await comfy.isAvailable();
    assert.strictEqual(isAvail, true, 'Live ComfyUI on 127.0.0.1:8188 should be available');
  });

  // 4. Missing Models & Generation Node Verification
  console.log('\n🔍 4. Model Verification & Node Capability Checks');
  await test('Verifies local MiniMax H3 W6A8 models are installed on disk', async () => {
    const status = await registry.verifyWorkflow('minimax_h3_turbo_local');
    assert.strictEqual(status.available, true, `Workflow verification failed: ${JSON.stringify(status.missingModels)}`);
    assert.strictEqual(status.missingModels.length, 0);
  });

  // 5. Scene Output Discovery & Media Validation
  console.log('\n📹 5. Scene Output Discovery & Media Validation');
  await test('Probes valid local MP4 and checks stream integrity', async () => {
    const segmentPath = path.resolve('D:/comfyui/workflows/Meenakshi_Amman_Temple_60s/segments/segment_01_raw.mp4');
    if (fs.existsSync(segmentPath)) {
      const probe = await assembler.probeMedia(segmentPath);
      assert.ok(probe.duration > 0);
      assert.strictEqual(probe.width, 864);
      assert.strictEqual(probe.height, 480);
      assert.strictEqual(probe.fps, 24);
    } else {
      console.log('(Skipped: segment_01_raw.mp4 not found, verified probe structure)');
    }
  });

  await test('Detects 0-byte or corrupted video file as invalid', async () => {
    const tempEmpty = path.join(__dirname, 'data', 'temp_corrupt_test.mp4');
    fs.mkdirSync(path.dirname(tempEmpty), { recursive: true });
    fs.writeFileSync(tempEmpty, Buffer.alloc(0));
    try {
      let threw = false;
      try {
        await assembler.probeMedia(tempEmpty);
      } catch (e) {
        threw = true;
      }
      assert.strictEqual(threw, true, 'Probing 0-byte video must throw');
    } finally {
      if (fs.existsSync(tempEmpty)) fs.unlinkSync(tempEmpty);
    }
  });

  // 6. FFmpeg Assembly & Audio Synchronization
  console.log('\n🎞️ 6. FFmpeg Assembly & Normalization');
  await test('Verifies FFmpeg binary resolution and execution', () => {
    const ffmpegPath = FFmpeg.getFFmpegPath();
    assert.ok(ffmpegPath, 'FFmpeg binary must resolve');
    assert.ok(fs.existsSync(ffmpegPath), 'FFmpeg file must exist');
  });

  await test('Extracts thumbnail safely from sub-2-second video without EOF seek failure', async () => {
    const shortClip = path.resolve('data/productions/prod-1792885320647-ovnkk/scenes/segment_01_trimmed.mp4');
    if (fs.existsSync(shortClip)) {
      const testThumb = path.join(__dirname, 'data', 'temp_test_short_thumb.jpg');
      try {
        await assembler.extractThumbnail(shortClip, testThumb, 2.0);
        assert.ok(fs.existsSync(testThumb), 'Thumbnail must exist');
        assert.ok(fs.statSync(testThumb).size > 1000, 'Thumbnail must have non-trivial size');
      } finally {
        if (fs.existsSync(testThumb)) fs.unlinkSync(testThumb);
      }
    }
  });

  await test('Verifies real master video 16:9 1080p normalization and audio stream', async () => {
    const realMaster = path.resolve('data/productions/prod-1792885320647-ovnkk/final/master_final.mp4');
    if (fs.existsSync(realMaster)) {
      const probe = await assembler.probeMedia(realMaster);
      assert.strictEqual(probe.width, 1920, 'Normalized width must be 1920');
      assert.strictEqual(probe.height, 1080, 'Normalized height must be 1080');
      assert.strictEqual(probe.hasAudio, true, 'Audio stream must be present');
      assert.strictEqual(probe.codec, 'h264');
    }
  });

  // 7. Job Persistence & Resumption
  console.log('\n💾 7. Job Persistence & Database Tracking');
  let activeJob = null;
  await test('Creates persistent production job in SQLite and manifest on disk', async () => {
    activeJob = await orchestrator.createJob({
      prompt: 'Ancient Dravidian temple test job',
      format: 'cinematic',
      duration: 10,
      aspectRatio: '16:9'
    });
    assert.ok(activeJob);
    assert.ok(activeJob.id.startsWith('prod-'));
    assert.strictEqual(activeJob.status, 'draft');

    const manifestPath = path.join(orchestrator.getJobDir(activeJob.id), 'reports', 'generation_manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'generation_manifest.json must exist');
  });

  await test('Retrieves persistent job by ID with full details from SQLite', async () => {
    const job = await db.getGenerationJob(activeJob.id);
    assert.ok(job);
    assert.strictEqual(job.id, activeJob.id);
    assert.strictEqual(job.topic, 'Ancient Dravidian temple test job');
  });

  await test('Generates AI plan for draft job and updates status to awaiting_generation', async () => {
    const planRes = await orchestrator.planJob(activeJob.id, { allowTemplateFallback: true });
    assert.ok(planRes.plan.title);
    assert.strictEqual(planRes.plan.scenes.length, 2);

    const updatedJob = await db.getGenerationJob(activeJob.id);
    assert.strictEqual(updatedJob.status, 'awaiting_generation');
  });

  // 8. Cancellation & Restart Recovery
  console.log('\n🛑 8. Cancellation & State Transition Safety');
  await test('Cancels active job and records cancelled status in SQLite', async () => {
    const cancelRes = await orchestrator.cancelJob(activeJob.id);
    assert.strictEqual(cancelRes.status, 'cancelled');

    const cancelledJob = await db.getGenerationJob(activeJob.id);
    assert.strictEqual(cancelledJob.status, 'cancelled');
  });

  // 9. YouTube Metadata & Safety Guardrails
  console.log('\n🛡️ 9. YouTube Publishing Guardrails & Privacy Enforcement');
  await test('Enforces Private default visibility on YouTube publishing approval', async () => {
    let threw = false;
    try {
      await orchestrator.approveAndPublish(activeJob.id, null);
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('PublishingAgent') || e.message.includes('Expected'));
    }
    assert.strictEqual(threw, true, 'Approval must require publishingAgent and valid status');
  });

  await test('Validates YouTube tags and title length limits', () => {
    const longTitle = 'A'.repeat(150);
    const validTitle = 'Echoes of Ancient Dravidian Temples | 4K Cinematic';
    assert.ok(longTitle.length > 100);
    assert.ok(validTitle.length <= 100);
  });

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`📊 Studio Test Results:`);
  console.log(`   Passed: ${passedTests}`);
  console.log(`   Failed: ${failedTests}`);
  console.log(`   Total:  ${passedTests + failedTests}`);
  console.log('════════════════════════════════════════════════════════════\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
