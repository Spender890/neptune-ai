#!/usr/bin/env node
/**
 * Reproducible local microbenchmark for FastPathRouter.match().
 *
 * Scope & Methodology Notice:
 *   This measures ONLY pure in-memory regex intent matching in FastPathRouter.
 *   It does NOT include Fastify HTTP serialization, Home Assistant REST calls,
 *   Jellyfin lookups, Asterisk spool I/O, Whisper STT, Piper TTS, or Ollama inference.
 *
 * Run with Node (>=22.6) + project loader:
 *   node --import ./backend/test/ts-loader.mjs scripts/benchmark-fastpath.ts
 */

import * as os from 'node:os';
import { FastPathRouter } from '../backend/src/fastpath';

interface SampleCase {
  label: string;
  utterance: string;
  expectedIntent: string | null;
}

const SAMPLE_CASES: SampleCase[] = [
  { label: 'light_on', utterance: 'turn on the living room light', expectedIntent: 'ha_toggle' },
  { label: 'light_off', utterance: 'turn off the kitchen lights', expectedIntent: 'ha_toggle' },
  { label: 'climate_set', utterance: 'set thermostat to 22 degrees', expectedIntent: 'climate_temp' },
  { label: 'tv_state', utterance: 'what is playing on the tv', expectedIntent: 'tv_state_query' },
  { label: 'tv_sound_arc', utterance: 'route tv audio through the home speakers', expectedIntent: 'tv_sound_output' },
  { label: 'lock_gate', utterance: 'unlock the front door', expectedIntent: 'ha_lock' },
  { label: 'cover_gate', utterance: 'open the garage door', expectedIntent: 'ha_cover' },
  { label: 'reminder', utterance: 'remind me to check laundry in 10 minutes', expectedIntent: 'set_reminder' },
  { label: 'call_sip', utterance: 'call desk and tell them dinner is ready', expectedIntent: 'telephony_call_message' },
  { label: 'llm_fallback', utterance: 'summarize my afternoon schedule and suggest dinner', expectedIntent: null },
];

const WARMUP_ITERATIONS = 1_000;
const MEASURED_ITERATIONS = 10_000;

function percentile(sortedUs: number[], p: number): number {
  if (sortedUs.length === 0) return 0;
  const idx = Math.min(
    sortedUs.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedUs.length) - 1)
  );
  return sortedUs[idx];
}

function formatUs(us: number): string {
  return `${us.toFixed(2)} us (${(us / 1000).toFixed(4)} ms)`;
}

function main(): void {
  const router = new FastPathRouter('media_player.lg_webos_tv_oled55c1', 'media_player.whole_house_speaker');

  // Verify deterministic routing before benchmarking
  for (const sample of SAMPLE_CASES) {
    const result = router.match(sample.utterance);
    if (sample.expectedIntent === null) {
      if (result.matched) {
        throw new Error(`Expected fallback (matched=false) for "${sample.utterance}", got ${result.intent}`);
      }
    } else if (!result.matched || result.intent !== sample.expectedIntent) {
      throw new Error(
        `Unexpected FastPath result for "${sample.utterance}": matched=${result.matched}, intent=${result.intent}`
      );
    }
  }

  // JIT warm-up
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    const sample = SAMPLE_CASES[i % SAMPLE_CASES.length];
    router.match(sample.utterance);
  }

  // Measured pass
  const latenciesUs: number[] = new Array(MEASURED_ITERATIONS);
  const startAllNs = process.hrtime.bigint();

  for (let i = 0; i < MEASURED_ITERATIONS; i++) {
    const sample = SAMPLE_CASES[i % SAMPLE_CASES.length];
    const t0 = process.hrtime.bigint();
    router.match(sample.utterance);
    const t1 = process.hrtime.bigint();
    latenciesUs[i] = Number(t1 - t0) / 1_000;
  }

  const endAllNs = process.hrtime.bigint();
  const totalMs = Number(endAllNs - startAllNs) / 1_000_000;
  const throughput = (MEASURED_ITERATIONS / totalMs) * 1_000;

  const sorted = [...latenciesUs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;

  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'unknown';

  const report = {
    benchmark: 'neptune-fastpath-microbenchmark',
    methodology: 'Synthetic in-memory CPU benchmark of FastPathRouter.match() only; excludes all I/O, HTTP, STT/TTS, and LLM latency.',
    timestamp_utc: new Date().toISOString(),
    environment: {
      node_version: process.version,
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      cpu_model: cpuModel,
      logical_cores: cpus.length,
      total_ram_gib: Number((os.totalmem() / (1024 ** 3)).toFixed(2)),
    },
    parameters: {
      sample_corpus_size: SAMPLE_CASES.length,
      warmup_iterations: WARMUP_ITERATIONS,
      measured_iterations: MEASURED_ITERATIONS,
    },
    results: {
      total_wall_ms: Number(totalMs.toFixed(3)),
      throughput_ops_per_sec: Math.round(throughput),
      min_us: Number(sorted[0].toFixed(2)),
      mean_us: Number(mean.toFixed(2)),
      p50_us: Number(percentile(sorted, 50).toFixed(2)),
      p95_us: Number(percentile(sorted, 95).toFixed(2)),
      p99_us: Number(percentile(sorted, 99).toFixed(2)),
      max_us: Number(sorted[sorted.length - 1].toFixed(2)),
    },
  };

  console.log('=== Neptune-AI FastPath Synthetic Microbenchmark ===');
  console.log(`CPU        : ${report.environment.cpu_model} (${report.environment.logical_cores} logical cores)`);
  console.log(`OS / Node  : ${report.environment.platform} | Node ${report.environment.node_version}`);
  console.log(`Iterations : ${MEASURED_ITERATIONS} measured (${WARMUP_ITERATIONS} warm-up), ${SAMPLE_CASES.length} sample utterances`);
  console.log(`Min        : ${formatUs(report.results.min_us)}`);
  console.log(`Mean       : ${formatUs(report.results.mean_us)}`);
  console.log(`p50        : ${formatUs(report.results.p50_us)}`);
  console.log(`p95        : ${formatUs(report.results.p95_us)}`);
  console.log(`p99        : ${formatUs(report.results.p99_us)}`);
  console.log(`Max        : ${formatUs(report.results.max_us)}`);
  console.log(`Throughput : ${report.results.throughput_ops_per_sec.toLocaleString('en-US')} match/s`);
  console.log('');
  console.log('JSON Summary:');
  console.log(JSON.stringify(report, null, 2));
}

main();
