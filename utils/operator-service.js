const fs = require('fs').promises;
const axios = require('axios');
const { Logger } = require('./logger');

class OperatorService {
  constructor(db) {
    this.db = db;
    this.logger = new Logger('OperatorService');
  }

  async runQualityChecks(production, profile = {}) {
    const title = String(production.seo?.title || production.script?.title || '').trim();
    const description = String(production.seo?.description || '').trim();
    const tags = Array.isArray(production.seo?.tags) ? production.seo.tags : [];
    const script = String(
      production.script?.fullScript ||
      production.script?.text ||
      (Array.isArray(production.script?.scenes)
        ? production.script.scenes.map(s => [s.visual_prompt, s.narration_text, s.soundscape_prompt].filter(Boolean).join('\n')).join('\n\n')
        : '') ||
      ''
    ).trim();
    const finalVideo = production.assets?.finalVideo || production.assets?.video;
    const thumbnail = production.assets?.thumbnail;
    const bannedTopics = Array.isArray(profile.bannedTopics) ? profile.bannedTopics : [];
    const combinedText = `${title}\n${description}\n${script}`.toLowerCase();

    const checks = [
      this.check('title', title.length > 0 && title.length <= 100,
        title ? `Title is ${title.length}/100 characters` : 'A title is required'),
      this.check('description', description.length >= 50,
        description.length >= 50 ? 'Description is detailed enough' : 'Description should be at least 50 characters'),
      this.check('tags', tags.length >= 3,
        tags.length >= 3 ? `${tags.length} tags provided` : 'Add at least 3 relevant tags', false),
      this.check('script', script.length >= 200,
        script.length >= 200 ? 'Script content is present' : 'Script is missing or unusually short'),
      this.check('thumbnail', Boolean(thumbnail?.path && !thumbnail?.simulated),
        thumbnail?.simulated
          ? 'Thumbnail is a placeholder; no image was generated'
          : thumbnail?.path ? 'Thumbnail asset is present' : 'Thumbnail asset is missing', false),
      this.check('video', Boolean(finalVideo?.path && !finalVideo?.simulated),
        finalVideo?.simulated
          ? 'Only a simulated video was produced'
          : finalVideo?.path ? 'Final MP4 is ready' : 'Final MP4 is missing')
    ];

    const topic = String(production.strategy?.topic || '').trim();
    if (topic) {
      const duplicates = await this.db.getRow(
        `SELECT COUNT(*) AS count FROM content_strategies
         WHERE lower(trim(topic)) = lower(trim(?))
         AND created_at >= datetime('now', '-90 days')`,
        [topic]
      );
      const unique = Number(duplicates?.count || 0) <= 1;
      checks.push(this.check('duplicate_topic', unique,
        unique
          ? 'No duplicate topic detected in the last 90 days'
          : 'This exact topic was already generated recently', false));
    }

    if (finalVideo?.path && !finalVideo?.simulated) {
      const exists = await this.fileExists(finalVideo.path);
      checks.push(this.check('video_file', exists,
        exists ? 'Final video file exists on disk' : 'Final video file is missing on disk', true));

      const targetDuration = Number(
        production.strategy?.targetDuration ||
        production.strategy?.target_duration ||
        production.targetDuration ||
        (Array.isArray(production.script?.scenes) && production.script.scenes.length ? production.script.scenes.reduce((acc, s) => acc + Number(s.duration_seconds || s.duration || 0), 0) : null) ||
        (Array.isArray(production.scenes) && production.scenes.length ? production.scenes.reduce((acc, s) => acc + Number(s.duration || 0), 0) : null) ||
        production.estimated_duration ||
        0
      );
      const actualDuration = Number(finalVideo.duration || 0);

      if (targetDuration > 0) {
        const minAcceptable = Math.max(3.0, targetDuration * 0.8);
        const durationPassed = actualDuration >= minAcceptable;
        checks.push(this.check('duration', durationPassed,
          durationPassed
            ? `Duration: ${actualDuration.toFixed(2)}s matches target (${targetDuration}s)`
            : `Duration shortfall: actual duration ${actualDuration.toFixed(2)}s is below target ${targetDuration}s (min: ${minAcceptable.toFixed(1)}s)`,
          true
        ));
      } else if (finalVideo.duration !== undefined) {
        const durationPassed = actualDuration >= 3.0;
        checks.push(this.check('duration', durationPassed,
          durationPassed
            ? `Duration: ${actualDuration.toFixed(2)}s is sufficient`
            : `Duration is too short (${actualDuration.toFixed(2)}s; minimum 3.0s required)`,
          true
        ));
      }

      if (finalVideo.width || finalVideo.height) {
        const width = Number(finalVideo.width || 0);
        const height = Number(finalVideo.height || 0);
        const aspectRatio = String(production.strategy?.aspectRatio || '16:9').trim();
        const isVertical = aspectRatio === '9:16' || height > width;
        const validResolution = isVertical
          ? (width === 1080 && height === 1920) || (width > 0 && height > width)
          : (width === 1920 && height === 1080) || (width > 0 && width > height);

        checks.push(this.check('resolution', validResolution,
          validResolution
            ? `Resolution: ${width}x${height} matches ${aspectRatio} aspect ratio`
            : `Invalid resolution ${width}x${height} for ${aspectRatio} format`,
          true
        ));
      }
    }

    const audio = production.assets?.audio || {};
    const intentionalSilence = audio.intentionalSilence === true &&
      String(audio.silenceReason || '').trim().length >= 10 &&
      Boolean(audio.silenceConfirmedAt);
    const productionAudioReady = !audio.simulated && await this.fileExists(audio.path);
    const scenes = production.scenes || [];
    let sceneAudioReady = false;
    if (scenes.length) {
      const readiness = [];
      for (const scene of scenes) {
        readiness.push(scene.narrationStatus === 'intentional_silence' || (
          scene.narrationStatus === 'current' && await this.fileExists(scene.audioPath)
        ));
      }
      sceneAudioReady = readiness.every(Boolean);
    }
    const narrationReady = intentionalSilence || productionAudioReady || sceneAudioReady;
    checks.push(this.check('narration', narrationReady,
      intentionalSilence
        ? `Intentional silence confirmed: ${audio.silenceReason}`
        : narrationReady
          ? `Narration is ready${audio.provider ? ` via ${audio.provider}` : ''}`
          : audio.intentionalSilence
            ? 'Intentional silence requires an operator confirmation and reason of at least 10 characters'
            : 'Narration is missing or unusable; regenerate it before approval'));

    const matchedBannedTopics = bannedTopics.filter(topic =>
      topic && combinedText.includes(String(topic).toLowerCase())
    );
    checks.push(this.check('brand_policy', matchedBannedTopics.length === 0,
      matchedBannedTopics.length
        ? `Content matches blocked terms: ${matchedBannedTopics.join(', ')}`
        : 'No blocked brand topics detected'));

    const provenance = production.provenance || {};
    const provenancePassed = ['verified', 'not_required'].includes(provenance.status || 'not_required');
    const unresolved = Number(provenance.summary?.unresolvedClaims || 0);
    checks.push(this.check('provenance', provenancePassed,
      provenance.status === 'verified'
        ? `${provenance.summary?.resolvedClaims || 0} factual claims resolved against reviewed evidence`
        : provenance.status === 'not_required'
          ? 'No externally verifiable factual claims were declared'
          : `${unresolved} factual claim${unresolved === 1 ? '' : 's'} still require evidence review`));

    const discoverability = production.discoverability;
    if (discoverability) {
      const actionable = (discoverability.findings || []).filter(finding =>
        ['CRITICAL', 'HIGH'].includes(finding.severity) && finding.reviewStatus !== 'dismissed'
      );
      const available = discoverability.status !== 'unavailable';
      checks.push(this.check(
        'discoverability',
        available && actionable.length === 0,
        !available
          ? `DarkzSEO advisory audit is unavailable${discoverability.error ? `: ${discoverability.error}` : ''}`
          : actionable.length
            ? `${actionable.length} high-priority discoverability finding${actionable.length === 1 ? '' : 's'} await remediation or dismissal`
            : `${discoverability.findings?.length || 0} discoverability finding${discoverability.findings?.length === 1 ? '' : 's'} recorded; no unresolved high-priority findings`,
        false
      ));
    }

    if (scenes.length) {
      const invalidScenes = scenes.filter(scene =>
        !scene.assetPath || ['missing_asset', 'failed', 'generating', 'needs_rebuild', 'visual_stale'].includes(scene.status) ||
        !['current', 'intentional_silence'].includes(scene.narrationStatus)
      );
      const unlicensedUploads = scenes.filter(scene => scene.assetOrigin === 'uploaded' && !scene.rightsConfirmed);
      checks.push(this.check('scene_integrity', invalidScenes.length === 0,
        invalidScenes.length === 0
          ? `${scenes.length} scene${scenes.length === 1 ? '' : 's'} are rebuilt and current`
          : `${invalidScenes.length} scene${invalidScenes.length === 1 ? '' : 's'} still require repair or rebuild`));
      checks.push(this.check('scene_rights', unlicensedUploads.length === 0,
        unlicensedUploads.length === 0
          ? 'Replacement scene assets have rights confirmation'
          : `${unlicensedUploads.length} uploaded scene asset${unlicensedUploads.length === 1 ? '' : 's'} lack rights confirmation`));
    }

    const blockingFailures = checks.filter(check => check.blocking && !check.passed);
    return {
      passed: blockingFailures.length === 0,
      score: Math.round((checks.filter(check => check.passed).length / checks.length) * 100),
      blockingFailures: blockingFailures.map(check => check.id),
      checks
    };
  }

  check(id, passed, message, blocking = true) {
    return { id, passed: Boolean(passed), blocking, message };
  }

  async fileExists(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }

  async notify(notification) {
    const enabled = await this.db.getSetting('notification_enabled');
    if (enabled === 'false') return null;

    const id = await this.db.createNotification(notification);
    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        await axios.post(webhookUrl, {
          text: `${notification.title}: ${notification.message}`,
          content: `${notification.title}: ${notification.message}`,
          ...notification
        }, { timeout: 5000 });
      } catch (error) {
        this.logger.warn(`Notification webhook failed: ${error.message}`);
      }
    }
    return id;
  }
}

module.exports = { OperatorService };
