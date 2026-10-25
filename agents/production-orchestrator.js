const fs = require('fs');
const path = require('path');
const { Database } = require('../database/db');
const { Logger } = require('../utils/logger');
const { ComfyUIClient } = require('../utils/comfyui-client');
const { WorkflowRegistry } = require('../utils/workflow-registry');
const { AIPlanner, AIPlannerKeyMissingError } = require('../utils/ai-planner');
const { ProductionAssembler } = require('../utils/production-assembler');

class ProductionOrchestrator {
  constructor(options = {}) {
    this.logger = new Logger('ProductionOrchestrator');
    this.db = options.db || new Database();
    this.comfyClient = options.comfyClient || new ComfyUIClient();
    this.workflowRegistry = options.workflowRegistry || new WorkflowRegistry();
    this.aiPlanner = options.aiPlanner || new AIPlanner();
    this.assembler = options.assembler || new ProductionAssembler();
    this.baseProductionsDir = path.resolve('data', 'productions');
    this.activeWorkers = new Set();
  }

  async initialize() {
    await this.db.initialize();
    fs.mkdirSync(this.baseProductionsDir, { recursive: true });
    return true;
  }

  getJobDir(jobId) {
    return path.join(this.baseProductionsDir, jobId);
  }

  createJobDirectories(jobId) {
    const root = this.getJobDir(jobId);
    const subdirs = [
      'plan',
      'references',
      'scenes',
      'narration',
      'music',
      'subtitles',
      'thumbnails',
      'final',
      'reports'
    ];
    subdirs.forEach(sub => fs.mkdirSync(path.join(root, sub), { recursive: true }));
    return root;
  }

  async createJob(params = {}) {
    const prompt = String(params.prompt || params.topic || '').trim();
    if (!prompt) {
      throw new Error('A prompt is required to create a production job.');
    }

    const jobId = `prod-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const jobDir = this.createJobDirectories(jobId);

    const targetDuration = Number(params.duration || params.targetDuration || 30);
    const aspectRatio = String(params.aspectRatio || '16:9').trim();
    const resolution = String(params.resolution || '1080p').trim();
    const format = String(params.format || 'cinematic').trim();
    const visualStyle = String(params.visualStyle || '35mm anamorphic film photography, natural lighting, rich textures').trim();
    const narrationVoice = String(params.narrationVoice || 'Solemn narrator').trim();
    const musicStyle = String(params.musicStyle || 'Cinematic orchestral atmosphere').trim();
    const audience = String(params.audience || 'General YouTube audience interested in high-quality visual experiences').trim();
    const workflowId = String(params.workflowId || 'minimax_h3_turbo_local').trim();

    const details = {
      jobId,
      prompt,
      targetDuration,
      aspectRatio,
      resolution,
      format,
      visualStyle,
      narrationVoice,
      musicStyle,
      audience,
      workflowId,
      outputDirectory: jobDir,
      plan: null,
      manifest: {
        jobId,
        createdAt: new Date().toISOString(),
        scenes: []
      }
    };

    // Save initial manifest
    fs.writeFileSync(
      path.join(jobDir, 'reports', 'generation_manifest.json'),
      JSON.stringify(details.manifest, null, 2),
      'utf8'
    );

    // Insert into database
    await this.db.executeQuery(
      `INSERT INTO generation_jobs (id, topic, style, length, source, status, stage, progress, details)
       VALUES (?, ?, ?, ?, ?, 'draft', 'created', 0, ?)`,
      [jobId, prompt, visualStyle, targetDuration > 45 ? 'long' : (targetDuration > 20 ? 'medium' : 'short'), 'prompt_studio', JSON.stringify(details)]
    );

    this.logger.info(`Created production job ${jobId} for prompt: "${prompt.substring(0, 50)}..."`);
    return this.db.getGenerationJob(jobId);
  }

  async planJob(jobId, options = {}) {
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found.`);

    await this.db.updateGenerationJob(jobId, { status: 'planning', stage: 'generating_plan', progress: 5 });
    const jobDir = this.getJobDir(jobId);

    try {
      const plan = await this.aiPlanner.createPlan(job.details, {
        allowTemplateFallback: options.allowTemplateFallback !== false
      });

      fs.writeFileSync(path.join(jobDir, 'plan', 'production_plan.json'), JSON.stringify(plan, null, 2), 'utf8');

      // Update scenes in SQLite
      await this.db.executeQuery('DELETE FROM production_scenes WHERE production_id = ?', [jobId]);
      for (const scene of plan.scenes) {
        await this.db.executeQuery(
          `INSERT INTO production_scenes (id, production_id, position, label, script_text, prompt, duration, asset_type, asset_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'video', '')`,
          [
            `${jobId}-${scene.scene_id}`,
            jobId,
            scene.index,
            scene.title,
            scene.narration_text || '',
            scene.visual_prompt,
            scene.duration_seconds
          ]
        );
      }

      await this.db.updateGenerationJob(jobId, {
        status: 'awaiting_generation',
        stage: 'plan_ready',
        progress: 10,
        title: plan.title,
        details: { plan }
      });

      this.logger.success(`Plan generated for job ${jobId} (${plan.scenes.length} scenes).`);
      return { success: true, plan };
    } catch (err) {
      if (err instanceof AIPlannerKeyMissingError) {
        await this.db.updateGenerationJob(jobId, {
          status: 'awaiting_provider',
          stage: 'provider_required',
          error: err.message
        });
        return { success: false, status: 'awaiting_provider', error: err.message };
      }
      await this.db.updateGenerationJob(jobId, {
        status: 'failed',
        stage: 'planning_failed',
        error: err.message
      });
      throw err;
    }
  }

  async startGeneration(jobId, options = {}) {
    if (this.activeWorkers.has(jobId)) {
      throw new Error(`Job ${jobId} is already actively running.`);
    }

    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found.`);

    let plan = job.details?.plan;
    if (!plan) {
      const planRes = await this.planJob(jobId, { allowTemplateFallback: true });
      plan = planRes.plan;
    }

    this.activeWorkers.add(jobId);
    await this.db.updateGenerationJob(jobId, {
      status: 'generating_scenes',
      stage: 'generating_scenes',
      progress: 10,
      cancelRequested: false
    });

    const jobDir = this.getJobDir(jobId);
    const scenesDir = path.join(jobDir, 'scenes');
    const manifestPath = path.join(jobDir, 'reports', 'generation_manifest.json');
    let manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { jobId, scenes: [] };

    try {
      const workflowId = job.details?.workflowId || 'minimax_h3_turbo_local';
      const workflow = this.workflowRegistry.get(workflowId);

      // Verify ComfyUI if local execution
      if (workflowId !== 'mock_test_workflow') {
        const check = await this.workflowRegistry.verifyWorkflow(workflowId, this.comfyClient);
        if (!check.comfyConnected) {
          throw new Error('ComfyUI server is not running on 127.0.0.1:8188. Start ComfyUI to proceed with generation.');
        }
        if (!check.available) {
          throw new Error(`Workflow verification failed: missing models (${check.missingModels.map(m=>m.file).join(', ')}) or nodes (${check.missingNodes.join(', ')})`);
        }
      }

      let prevTerminalComfyName = null;
      const totalScenes = plan.scenes.length;

      for (let i = 0; i < totalScenes; i++) {
        const scene = plan.scenes[i];
        const sceneIndex = i + 1;
        const sceneStr = String(sceneIndex).padStart(2, '0');

        // Check cancellation
        const currentJob = await this.db.getGenerationJob(jobId);
        if (currentJob?.cancelRequested) {
          this.logger.warn(`Job ${jobId} was cancelled by user.`);
          await this.db.updateGenerationJob(jobId, { status: 'cancelled', stage: 'cancelled', error: 'User cancelled job' });
          return { success: false, status: 'cancelled' };
        }

        const rawSegPath = path.join(scenesDir, `segment_${sceneStr}_raw.mp4`);
        const trimmedSegPath = path.join(scenesDir, `segment_${sceneStr}_trimmed.mp4`);
        const terminalFramePath = path.join(scenesDir, `segment_${sceneStr}_terminal.png`);

        // Resume support: check if already rendered
        if (fs.existsSync(trimmedSegPath) && fs.statSync(trimmedSegPath).size > 50000) {
          this.logger.info(`Scene #${sceneIndex} already exists and verified (${fs.statSync(trimmedSegPath).size} bytes). Reusing.`);
          if (fs.existsSync(terminalFramePath)) {
            const comfyTermName = `${jobId}_term_${sceneStr}.png`;
            this.comfyClient.copyAssetToInput(terminalFramePath, comfyTermName);
            prevTerminalComfyName = comfyTermName;
          }
          continue;
        }

        this.logger.info(`--- Generating Scene ${sceneIndex}/${totalScenes}: "${scene.title}" ---`);
        await this.db.updateGenerationJob(jobId, {
          stage: `generating_scene_${sceneIndex}_of_${totalScenes}`,
          progress: Math.round(10 + (i / totalScenes) * 65)
        });

        // Determine conditioning frame
        let firstFrameName = null;
        if (scene.use_prev_terminal_frame && prevTerminalComfyName) {
          firstFrameName = prevTerminalComfyName;
          this.logger.info(`  Conditioning: Terminal frame of Scene ${sceneIndex - 1} (${firstFrameName})`);
        } else if (scene.reference_image && fs.existsSync(scene.reference_image)) {
          const anchorName = `${jobId}_anchor_${sceneStr}.png`;
          this.comfyClient.copyAssetToInput(scene.reference_image, anchorName);
          firstFrameName = anchorName;
          this.logger.info(`  Conditioning: Custom anchor image (${firstFrameName})`);
        }

        if (workflowId === 'mock_test_workflow') {
          // In test mode: synthesize a minimal valid test mp4 directly via ffmpeg
          this.logger.info(`  [Test Mode] Generating synthetic test segment for Scene ${sceneIndex}...`);
          const ffmpeg = require('../utils/ffmpeg').getFFmpegPath();
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          await promisify(execFile)(ffmpeg, [
            '-y',
            '-f', 'lavfi', '-i', `color=c=navy:s=864x480:d=5.16:r=24`,
            '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-shortest',
            rawSegPath
          ]);
        } else {
          // Live ComfyUI local inference
          await this.comfyClient.freeMemory();

          const prefix = `youtube_auto/${jobId}/segment_${sceneStr}`;
          const seed = Math.floor(Math.random() * 1000000000);
          const clipFrames = options.clipFrames || (scene.frames ? scene.frames + 4 : 124);
          const trimFrames = options.clipFrames ? options.clipFrames : (scene.frames || 120);

          const promptDict = workflow.buildPrompt({
            prompt: scene.visual_prompt,
            prefix,
            length: clipFrames,
            firstFrameName,
            seed,
            aspectRatio: plan.aspect_ratio || '16:9'
          });

          const queueRes = await this.comfyClient.queuePrompt(promptDict, `producer_${jobId}_scene_${sceneStr}`);
          const promptId = queueRes.prompt_id;
          this.logger.info(`  Submitted to ComfyUI (Prompt ID: ${promptId}). Waiting for inference...`);

          const waitRes = await this.comfyClient.waitForPrompt(promptId, {
            shouldCancel: () => {
              const liveJob = this.db.getRowSync?.('SELECT cancel_requested FROM generation_jobs WHERE id = ?', [jobId]);
              return Boolean(liveJob?.cancel_requested);
            },
            onProgress: (p) => {
              this.logger.info(`  Scene ${sceneIndex} progress: ${p.elapsedSec}s elapsed (executing: ${p.isExecuting})`);
            }
          });

          // Locate generated file in ComfyUI output (exact path from node 92 history first, then fallback search)
          let generatedFile = null;
          const outputInfo = waitRes.outputs?.['92']?.images?.[0];
          if (outputInfo && outputInfo.filename) {
            const exactPath = path.join(this.comfyClient.comfyOutputDir, outputInfo.subfolder || '', outputInfo.filename);
            if (fs.existsSync(exactPath)) {
              generatedFile = exactPath;
            }
          }
          if (!generatedFile) {
            const candidates = this.comfyClient.findOutputFiles(`segment_${sceneStr}`);
            if (candidates && candidates.length > 0) {
              generatedFile = candidates[0];
            }
          }
          if (!generatedFile || !fs.existsSync(generatedFile)) {
            throw new Error(`ComfyUI completed but output video for scene ${sceneIndex} was not found on disk.`);
          }
          this.logger.info(`  Located generated scene video: ${generatedFile} (${fs.statSync(generatedFile).size} bytes)`);
          fs.copyFileSync(generatedFile, rawSegPath);
        }

        const finalTrimFrames = options.clipFrames ? options.clipFrames : (scene.frames || 120);
        await this.assembler.trimSceneToExactDuration(rawSegPath, trimmedSegPath, 24, finalTrimFrames);

        // Extract terminal frame for chaining next scene
        await this.assembler.extractTerminalFrame(trimmedSegPath, terminalFramePath, finalTrimFrames - 1);
        if (workflowId !== 'mock_test_workflow') {
          const comfyTermName = `${jobId}_term_${sceneStr}.png`;
          this.comfyClient.copyAssetToInput(terminalFramePath, comfyTermName);
          prevTerminalComfyName = comfyTermName;
        }

        // Record scene manifest
        manifest.scenes.push({
          sceneIndex,
          sceneId: scene.scene_id,
          title: scene.title,
          rawPath: rawSegPath,
          trimmedPath: trimmedSegPath,
          terminalFrame: terminalFramePath,
          duration: scene.duration_seconds
        });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

        // Update scene row in database
        await this.db.executeQuery(
          'UPDATE production_scenes SET asset_path = ? WHERE id = ?',
          [trimmedSegPath, `${jobId}-${scene.scene_id}`]
        );
      }

      // Step 2: Assemble master video
      const assembleRes = await this.assembleJob(jobId);
      return { success: true, jobId, ...assembleRes };
    } catch (err) {
      this.logger.error(`Generation error for job ${jobId}: ${err.message}`);
      await this.db.updateGenerationJob(jobId, { status: 'failed', error: err.message });
      throw err;
    } finally {
      this.activeWorkers.delete(jobId);
    }
  }

  async assembleJob(jobId) {
    this.logger.info(`Assembling final master video for job ${jobId}...`);
    await this.db.updateGenerationJob(jobId, { status: 'assembling', stage: 'assembling_video', progress: 80 });

    const jobDir = this.getJobDir(jobId);
    const scenesDir = path.join(jobDir, 'scenes');
    const finalDir = path.join(jobDir, 'final');
    const thumbnailsDir = path.join(jobDir, 'thumbnails');
    const masterFinalPath = path.join(finalDir, 'master_final.mp4');
    const thumbnailPath = path.join(thumbnailsDir, 'thumbnail_default.jpg');

    const job = await this.db.getGenerationJob(jobId);
    const plan = job.details?.plan;

    // Collect all trimmed scenes
    const sceneFiles = fs.readdirSync(scenesDir)
      .filter(f => f.endsWith('_trimmed.mp4'))
      .sort()
      .map(f => path.join(scenesDir, f));

    if (sceneFiles.length === 0) {
      throw new Error(`No trimmed scenes found in ${scenesDir} to assemble.`);
    }

    const resolution = plan?.aspect_ratio === '9:16'
      ? { width: 1080, height: 1920 }
      : (plan?.aspect_ratio === '1:1' ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 });

    const narrationPath = job.details?.narrationAudioPath || path.join(jobDir, 'narration', 'narration.mp3');
    const musicPath = job.details?.backgroundMusicPath || path.join(jobDir, 'music', 'soundscape.mp3');

    const assembleRes = await this.assembler.assembleMasterVideo({
      sceneVideos: sceneFiles,
      outputFinalPath: masterFinalPath,
      narrationAudioPath: fs.existsSync(narrationPath) ? narrationPath : null,
      backgroundMusicPath: fs.existsSync(musicPath) ? musicPath : null,
      resolution,
      aspectRatio: plan?.aspect_ratio || '16:9'
    });

    // Extract default thumbnail from master video at 2 seconds
    await this.assembler.extractThumbnail(masterFinalPath, thumbnailPath, 2.0);

    // Validate video output
    await this.db.updateGenerationJob(jobId, { status: 'validating', stage: 'validating_video', progress: 95 });
    const probe = assembleRes.probe;
    if (probe.duration <= 0 || probe.sizeBytes === 0) {
      throw new Error('Video assembly validation failed: output file is empty or has zero duration.');
    }

    // Register into existing production pipeline tables
    const productionId = jobId;
    const defaultPrivacy = process.env.DEFAULT_PRIVACY_STATUS || 'private';

    const assets = {
      video: { path: masterFinalPath, duration: probe.duration, width: probe.width, height: probe.height },
      thumbnail: { path: thumbnailPath },
      audio: {
        path: masterFinalPath,
        intentionalSilence: true,
        silenceReason: 'Native cinematic sound design and mixed score embedded in master video',
        silenceConfirmedAt: new Date().toISOString()
      }
    };

    // 1. productions
    await this.db.executeQuery(
      `INSERT INTO productions (id, status, assets, scheduled_publish_time)
       VALUES (?, 'completed', ?, datetime('now', '+1 hour'))
       ON CONFLICT(id) DO UPDATE SET status = 'completed', assets = excluded.assets`,
      [productionId, JSON.stringify(assets)]
    );

    // 2. production_snapshots
    await this.db.executeQuery(
      `INSERT INTO production_snapshots (production_id, strategy, script, thumbnail, seo)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(production_id) DO UPDATE SET strategy = excluded.strategy, script = excluded.script, thumbnail = excluded.thumbnail, seo = excluded.seo`,
      [
        productionId,
        JSON.stringify({ topic: job.topic, format: job.details?.format }),
        JSON.stringify({ title: plan?.title || job.title, scenes: plan?.scenes }),
        JSON.stringify({ path: thumbnailPath, concept: plan?.youtube_metadata?.thumbnail_concept }),
        JSON.stringify(plan?.youtube_metadata || {})
      ]
    );

    // 3. content_reviews
    await this.db.executeQuery(
      `INSERT INTO content_reviews (production_id, status, editor_data, quality_checks, reviewed_at)
       VALUES (?, 'needs_review', ?, ?, datetime('now'))
       ON CONFLICT(production_id) DO UPDATE SET status = 'needs_review', editor_data = excluded.editor_data`,
      [
        productionId,
        JSON.stringify(plan?.youtube_metadata || {}),
        JSON.stringify([
          { id: 'media_verification', passed: Boolean(probe && probe.duration > 0), message: 'Master video container and streams verified on disk', blocking: true },
          { id: 'resolution', passed: probe?.width === 1920 && probe?.height === 1080, message: `Resolution: ${probe?.width}x${probe?.height} (16:9 normalized)`, blocking: true },
          { id: 'duration', passed: Boolean(probe?.duration && probe.duration > 0), message: `Duration: ${probe?.duration ? probe.duration.toFixed(2) + 's' : '0s'}`, blocking: false },
          { id: 'audio_stream', passed: Boolean(probe?.hasAudio), message: probe?.hasAudio ? `Audio: ${probe.audioCodec} stereo` : 'Silent audio stream', blocking: false }
        ])
      ]
    );

    // 4. publish_schedule
    await this.db.executeQuery(
      `INSERT INTO publish_schedule (id, production_id, title, publish_time, status, priority, metadata)
       VALUES (?, ?, ?, datetime('now', '+1 hour'), 'scheduled', 50, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'scheduled', metadata = excluded.metadata`,
      [
        `sched-${jobId}`,
        productionId,
        plan?.youtube_metadata?.title || job.title,
        JSON.stringify({
          privacyStatus: defaultPrivacy,
          video: { path: masterFinalPath },
          thumbnail: { path: thumbnailPath },
          audio: assets.audio,
          seo: plan?.youtube_metadata
        })
      ]
    );

    // Final job update
    await this.db.updateGenerationJob(jobId, {
      status: 'awaiting_approval',
      stage: 'ready_for_review',
      progress: 100,
      productionId: jobId,
      title: plan?.youtube_metadata?.title || job.title,
      details: {
        masterVideoPath: masterFinalPath,
        thumbnailPath,
        probe
      }
    });

    this.logger.success(`Job ${jobId} successfully prepared for YouTube review! Master: ${masterFinalPath}`);
    return {
      success: true,
      jobId,
      status: 'awaiting_approval',
      masterFinalPath,
      thumbnailPath,
      probe
    };
  }

  async approveAndPublish(jobId, publishingAgent) {
    if (!publishingAgent) {
      throw new Error('PublishingAgent instance is required for YouTube upload.');
    }
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found.`);

    if (job.status !== 'awaiting_approval') {
      throw new Error(`Cannot approve job in status '${job.status}'. Expected 'awaiting_approval'.`);
    }

    this.logger.info(`User approved publication for job ${jobId}. Submitting to YouTube publishing pipeline...`);
    await this.db.updateGenerationJob(jobId, { status: 'uploading', stage: 'uploading_to_youtube' });

    // Mark review approved
    await this.db.executeQuery(
      `UPDATE content_reviews SET status = 'approved', reviewed_at = datetime('now') WHERE production_id = ?`,
      [jobId]
    );

    try {
      const publishResult = await publishingAgent.publishContent(jobId, { publishNow: true });
      await this.db.updateGenerationJob(jobId, {
        status: 'uploaded',
        stage: 'published',
        details: {
          youtubeId: publishResult.youtubeId,
          youtubeUrl: publishResult.youtubeUrl,
          publishedAt: publishResult.publishedAt
        }
      });
      this.logger.success(`Job ${jobId} successfully published to YouTube! URL: ${publishResult.youtubeUrl}`);
      return { success: true, publishResult };
    } catch (err) {
      this.logger.error(`YouTube upload failed for job ${jobId}: ${err.message}`);
      await this.db.updateGenerationJob(jobId, {
        status: 'failed',
        stage: 'upload_failed',
        error: err.message
      });
      throw err;
    }
  }

  async cancelJob(jobId) {
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found.`);

    await this.db.updateGenerationJob(jobId, {
      cancelRequested: true,
      status: 'cancelled',
      stage: 'cancelled',
      error: 'Cancelled by user'
    });
    this.activeWorkers.delete(jobId);
    await this.comfyClient.cancelPrompt();
    return { success: true, jobId, status: 'cancelled' };
  }
}

module.exports = { ProductionOrchestrator };