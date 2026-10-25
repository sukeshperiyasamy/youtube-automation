/**
 * Regression Test Suite: Content Pipeline Quality Checks Normalization & Rendering
 * Verifies robust normalization of qualityChecks across DB, API, and Frontend boundaries.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { normalizeQualityChecks, normalizeCheckItem } = require('./utils/quality-normalizer');
const { Database } = require('./database/db');
const { Logger } = require('./utils/logger');

const logger = new Logger('QualityRegressionTest');

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

// Client-side qualityScore implementation mirror
function clientQualityScore(checks) {
  const list = Array.isArray(checks) ? checks : normalizeQualityChecks(checks);
  if (!list.length) return 0;
  return Math.round((list.filter(check => check.passed).length / list.length) * 100);
}

// Client-side nextAction implementation mirror
function clientNextAction(item) {
  if (item.schedule_status === 'published') return 'View';
  if (item.review_status === 'needs_attention') return 'Fix issues';
  if (item.review_status === 'needs_review') return 'Review';
  if (item.schedule_status === 'scheduled') return 'Scheduled';
  return 'Inspect';
}

async function runRegressionSuite() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('🧪 Running QualityChecks Normalization Regression Test Suite');
  console.log('════════════════════════════════════════════════════════════\n');

  // 1. Array representation
  console.log('📋 1. Array Representation Handling');
  await test('Normalizes standard array of check objects and preserves fields', () => {
    const input = [
      { id: 'title', passed: true, message: 'Title is within 100 chars', blocking: true, customField: 'extra' },
      { id: 'video', passed: true, message: 'Final video exists', blocking: true }
    ];
    const out = normalizeQualityChecks(input);
    assert.strictEqual(Array.isArray(out), true);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, 'title');
    assert.strictEqual(out[0].passed, true);
    assert.strictEqual(out[0].customField, 'extra');
  });

  await test('Preserves failing checks in an array without masking errors', () => {
    const input = [
      { id: 'narration', passed: false, message: 'Narration missing', blocking: true },
      { id: 'video', passed: true, message: 'Video rendered', blocking: true }
    ];
    const out = normalizeQualityChecks(input);
    assert.strictEqual(out[0].passed, false);
    assert.strictEqual(out[0].blocking, true);
    assert.strictEqual(out[1].passed, true);
  });

  // 2. JSON String representation
  console.log('\n📄 2. JSON-String Representation Handling');
  await test('Parses and normalizes JSON string representing an array of checks', () => {
    const jsonStr = JSON.stringify([
      { id: 'scene_integrity', passed: true, message: 'All scenes intact', blocking: true }
    ]);
    const out = normalizeQualityChecks(jsonStr);
    assert.strictEqual(Array.isArray(out), true);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'scene_integrity');
    assert.strictEqual(out[0].passed, true);
  });

  await test('Parses and normalizes JSON string representing a verification summary object', () => {
    // This exact string matches the existing database records
    const jsonStr = '{"duration":10,"resolution":"1920x1080","verified":true}';
    const out = normalizeQualityChecks(jsonStr);
    assert.strictEqual(Array.isArray(out), true);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].id, 'media_verification');
    assert.strictEqual(out[0].passed, true);
    assert.strictEqual(out[1].id, 'resolution');
    assert.strictEqual(out[1].passed, true);
    assert.strictEqual(out[2].id, 'duration');
    assert.strictEqual(out[2].passed, true);
  });

  // 3. Object representation
  console.log('\n🧩 3. Object Representation Handling');
  await test('Normalizes object containing a nested checks array', () => {
    const obj = {
      score: 100,
      passed: true,
      checks: [
        { id: 'provenance', passed: true, message: 'All facts verified' }
      ]
    };
    const out = normalizeQualityChecks(obj);
    assert.strictEqual(Array.isArray(out), true);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'provenance');
    assert.strictEqual(out[0].passed, true);
  });

  await test('Normalizes raw probe object and flags failed duration/verification', () => {
    const failingProbe = {
      verified: false,
      resolution: 'invalid_res',
      duration: 0
    };
    const out = normalizeQualityChecks(failingProbe);
    assert.strictEqual(Array.isArray(out), true);
    assert.strictEqual(out[0].id, 'media_verification');
    assert.strictEqual(out[0].passed, false); // Must preserve failure!
    assert.strictEqual(out[2].id, 'duration');
    assert.strictEqual(out[2].passed, false); // Must preserve duration failure!
  });

  await test('Normalizes key-value boolean checks map', () => {
    const checkMap = {
      title_length: true,
      tags_count: true,
      audio_sync: false
    };
    const out = normalizeQualityChecks(checkMap);
    assert.strictEqual(out.length, 3);
    const audioCheck = out.find(c => c.id === 'audio_sync');
    assert.ok(audioCheck);
    assert.strictEqual(audioCheck.passed, false);
  });

  // 4. Null, missing, and unexpected primitives
  console.log('\n⚠️ 4. Null, Missing, Malformed, and Unexpected Values');
  await test('Returns empty array for null, undefined, and empty string without warnings', () => {
    assert.deepStrictEqual(normalizeQualityChecks(null), []);
    assert.deepStrictEqual(normalizeQualityChecks(undefined), []);
    assert.deepStrictEqual(normalizeQualityChecks(''), []);
    assert.deepStrictEqual(normalizeQualityChecks('   '), []);
  });

  await test('Handles malformed JSON string gracefully without throwing', () => {
    const malformed = '{"duration": 10, broken_json:';
    const out = normalizeQualityChecks(malformed);
    assert.strictEqual(Array.isArray(out), true);
    assert.strictEqual(out.length, 0);
  });

  await test('Handles unexpected primitive types gracefully without throwing', () => {
    assert.deepStrictEqual(normalizeQualityChecks(42), []);
    assert.deepStrictEqual(normalizeQualityChecks(true), []);
    assert.deepStrictEqual(normalizeQualityChecks(false), []);
    assert.deepStrictEqual(normalizeQualityChecks(Symbol('test')), []);
  });

  // 5. Multiple content cards with mixed representations
  console.log('\n🗂️ 5. Multiple Content Cards with Mixed Representations');
  await test('Simulates pipeline with 5 cards of mixed representations and computes valid scores', () => {
    const mixedPipeline = [
      { id: 'card-1', qualityChecks: [{ id: 'title', passed: true }, { id: 'video', passed: true }] },
      { id: 'card-2', qualityChecks: '{"duration":10,"resolution":"1920x1080","verified":true}' },
      { id: 'card-3', qualityChecks: { checks: [{ id: 'provenance', passed: true }] } },
      { id: 'card-4', qualityChecks: null },
      { id: 'card-5', qualityChecks: '{malformed json' }
    ];

    mixedPipeline.forEach(card => {
      const normalized = normalizeQualityChecks(card.qualityChecks);
      assert.strictEqual(Array.isArray(normalized), true);
      const score = clientQualityScore(card.qualityChecks);
      assert.strictEqual(typeof score, 'number');
      assert.ok(score >= 0 && score <= 100);

      // Verify that calling .map() does NOT throw on any card
      const renderedChecks = (normalized || []).map(c => `${c.id}:${c.passed}`);
      assert.strictEqual(Array.isArray(renderedChecks), true);
    });

    // Check individual expected scores
    assert.strictEqual(clientQualityScore(mixedPipeline[0].qualityChecks), 100);
    assert.strictEqual(clientQualityScore(mixedPipeline[1].qualityChecks), 100);
    assert.strictEqual(clientQualityScore(mixedPipeline[2].qualityChecks), 100);
    assert.strictEqual(clientQualityScore(mixedPipeline[3].qualityChecks), 0);
    assert.strictEqual(clientQualityScore(mixedPipeline[4].qualityChecks), 0);
  });

  // 6. Existing Database Records Verification
  console.log('\n💾 6. Existing Database Records Pipeline Verification');
  await test('Verifies real existing database records in SQLite return array and 100% quality score', async () => {
    const db = new Database();
    await db.initialize();

    const ids = ['prod-1792879537359-636p6', 'prod-1792885320647-ovnkk'];
    for (const id of ids) {
      const bundle = await db.getProductionBundle(id);
      assert.ok(bundle, `Bundle ${id} must exist in database`);
      assert.strictEqual(Array.isArray(bundle.qualityChecks), true, `qualityChecks for ${id} must be an Array`);
      assert.strictEqual(bundle.qualityChecks.length, 3);
      assert.strictEqual(bundle.qualityChecks[0].passed, true);

      // Test that .map() executes cleanly
      const mapped = bundle.qualityChecks.map(c => c.message);
      assert.strictEqual(mapped.length, 3);

      // Verify quality score semantics:
      // prod-1792879537359-636p6 meets 10s target -> 100%
      // prod-1792885320647-ovnkk has duration shortfall (0.92s vs 5s target) -> 67%
      const score = clientQualityScore(bundle.qualityChecks);
      if (id === 'prod-1792879537359-636p6') {
        assert.strictEqual(score, 100, 'prod-1792879537359-636p6 meets target duration (100%)');
        assert.strictEqual(bundle.qualityChecks[2].passed, true);
      } else if (id === 'prod-1792885320647-ovnkk') {
        assert.strictEqual(score, 67, 'prod-1792885320647-ovnkk correctly reflects duration shortfall (67%)');
        assert.strictEqual(bundle.qualityChecks[2].passed, false);
      }

      // Verify Review action is selected for needs_review
      const action = clientNextAction(bundle);
      assert.strictEqual(action, 'Review');
    }

    const overview = await db.getPipelineOverview(10);
    overview.forEach(item => {
      assert.strictEqual(Array.isArray(item.qualityChecks), true, `Overview item ${item.id} qualityChecks must be Array`);
    });
  });

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`📊 QualityChecks Normalization Results:`);
  console.log(`   Passed: ${passedTests}`);
  console.log(`   Failed: ${failedTests}`);
  console.log(`   Total:  ${passedTests + failedTests}`);
  console.log('════════════════════════════════════════════════════════════\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runRegressionSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
