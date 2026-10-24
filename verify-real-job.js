const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { ProductionAssembler } = require('./utils/production-assembler');
const { ProductionOrchestrator } = require('./agents/production-orchestrator');
const { Database } = require('./database/db');
const { Logger } = require('./utils/logger');

const logger = new Logger('RealJobVerifier');

async function verifyJob() {
  const jobId = 'prod-1792885320647-ovnkk';
  logger.info(`Verifying real production job: ${jobId}...`);

  const db = new Database();
  await db.initialize();
  const assembler = new ProductionAssembler();

  const jobDir = path.resolve(`D:/comfyui/sukesh/youtube-automation-agent/data/productions/${jobId}`);
  const masterFinalPath = path.join(jobDir, 'final', 'master_final.mp4');
  const thumbnailPath = path.join(jobDir, 'thumbnails', 'thumbnail_default.jpg');
  const rawScenePath = path.join(jobDir, 'scenes', 'segment_01_raw.mp4');
  const trimmedScenePath = path.join(jobDir, 'scenes', 'segment_01_trimmed.mp4');

  // Assert all files exist
  assert.ok(fs.existsSync(rawScenePath), 'Raw scene must exist');
  assert.ok(fs.existsSync(trimmedScenePath), 'Trimmed scene must exist');
  assert.ok(fs.existsSync(masterFinalPath), 'Master final video must exist');
  assert.ok(fs.existsSync(thumbnailPath), 'Thumbnail must exist');

  const rawSize = fs.statSync(rawScenePath).size;
  const masterSize = fs.statSync(masterFinalPath).size;
  const thumbSize = fs.statSync(thumbnailPath).size;

  logger.info(`File Verification:`);
  logger.info(`  Raw Scene:       ${rawScenePath} (${(rawSize / 1024).toFixed(1)} KB)`);
  logger.info(`  Master Video:    ${masterFinalPath} (${(masterSize / 1024 / 1024).toFixed(2)} MB)`);
  logger.info(`  Thumbnail:       ${thumbnailPath} (${(thumbSize / 1024).toFixed(1)} KB)`);

  // Probe with FFprobe
  const probe = await assembler.probeMedia(masterFinalPath);
  logger.info(`FFprobe Validation:`);
  logger.info(`  Resolution:      ${probe.width}x${probe.height} (16:9 normalized)`);
  logger.info(`  Duration:        ${probe.duration.toFixed(2)}s`);
  logger.info(`  Video Codec:     ${probe.codec} @ ${probe.fps} fps`);
  logger.info(`  Audio Codec:     ${probe.audioCodec} (${probe.audioSampleRate} Hz, stereo)`);
  logger.info(`  Has Audio:       ${probe.hasAudio}`);

  assert.strictEqual(probe.width, 1920, 'Width must be 1920');
  assert.strictEqual(probe.height, 1080, 'Height must be 1080');
  assert.strictEqual(probe.hasAudio, true, 'Audio stream must be present');
  assert.ok(probe.duration > 0.5, 'Duration must be > 0.5s');

  // Verify DB state
  const job = await db.getGenerationJob(jobId);
  logger.info(`Database State:`);
  logger.info(`  Job Status:      ${job.status}`);
  logger.info(`  Job Stage:       ${job.stage}`);
  logger.info(`  Job Progress:    ${job.progress}%`);

  const reviewRows = await db.getAllRows(`SELECT * FROM content_reviews WHERE production_id = ?`, [jobId]);
  logger.info(`  Content Review:  ${reviewRows[0]?.status || 'none'}`);

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('✅ REAL-MODEL SMOKE TEST VERIFICATION PASSED');
  console.log('════════════════════════════════════════════════════════════\n');
}

verifyJob().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
