const fs = require('fs');
const path = require('path');

/**
 * Shared music application layer.
 *
 * Both the REST routes and the MCP tool are thin adapters over this class. It owns
 * request normalisation, GPU queue dispatch, job lifecycle, and the on-disk track
 * library, so neither transport re-implements the other's rules.
 *
 * The GPU queue cannot interrupt a running task, so cancellation is only honoured
 * for jobs that have not started yet. A running job reports `cancel_unsupported`
 * rather than pretending it stopped.
 */

let idCounter = 0;

function nextId(prefix) {
  idCounter = (idCounter + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(2, '0')}`;
}

class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled before it started.');
    this.name = 'JobCancelledError';
  }
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

class MusicService {
  constructor(musicEngine, gpuQueue, options = {}) {
    this.musicEngine = musicEngine;
    this.gpuQueue = gpuQueue;
    this.libraryDir = options.libraryDir || path.resolve(__dirname, '..', 'music_library');
    this.port = options.port || 8095;
    this.jobs = new Map();
    this.maxJobs = options.maxJobs || 200;
    // Set per-request by the HTTP layer so generated audio URLs point back at the
    // host the client actually used (localhost today, a LAN address tomorrow).
    this._publicBaseUrl = options.publicBaseUrl || null;
    fs.mkdirSync(this.libraryDir, { recursive: true });
  }

  setPublicBaseUrl(url) {
    if (url) this._publicBaseUrl = url;
  }

  baseUrl() {
    return (this._publicBaseUrl || `http://127.0.0.1:${this.port}`).replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------- normalise

  /** Shared by POST /v1/audio/music/plan and the MCP `plan` action. */
  normalizePlanRequest(body = {}) {
    const prompt = String(body.prompt ?? body.style ?? '').trim();
    const lyrics = String(body.lyrics ?? body.text ?? '').trim();

    if (!prompt && !lyrics) {
      throw badRequest("Either 'prompt' or 'lyrics' is required for music planning.");
    }

    return {
      prompt,
      lyrics,
      cot: body.cot || 'full',
      // 600 was truncating long-form scores mid-bar; a 2 minute composition
      // needs roughly 1.2-1.5k tokens of ABC.
      abcMaxTokens: body.abc_max_tokens || body.abcMaxTokens || 1600,
      lora: body.lora || null
    };
  }

  /** Shared by POST /v1/audio/music and the MCP `generate` action. */
  normalizeRenderRequest(body = {}) {
    const prompt = String(body.prompt ?? body.style ?? body.input ?? '').trim();
    const lyrics = String(body.lyrics ?? body.text ?? '').trim();
    const abcScore = body.abc_score || body.abc || body.abcScore || null;

    if (!prompt && !lyrics && !abcScore) {
      throw badRequest("Either 'prompt', 'lyrics', or 'abc_score' must be provided.");
    }

    return {
      model: body.model || 'yue2',
      prompt,
      lyrics,
      cot: body.cot || 'full',
      abcScore,
      durationSeconds: body.duration_seconds || body.duration || body.durationSeconds || 60,
      inferenceSteps: body.inference_steps || body.steps || body.inferenceSteps || 8,
      lora: body.lora || null,
      title: body.title || null
    };
  }

  // ------------------------------------------------------------------- engine

  /** Single call site for the engine, so both transports dispatch identically. */
  _callEngine(kind, params) {
    return kind === 'plan'
      ? this.musicEngine.planComposition(params)
      : this.musicEngine.renderMusic(params);
  }

  /** Blocking helpers used by the existing synchronous REST endpoints. */
  planSync(params) {
    return this.gpuQueue.enqueue(() => this._callEngine('plan', params));
  }

  renderSync(params) {
    return this.gpuQueue.enqueue(() => this._callEngine('render', params));
  }

  // --------------------------------------------------------------------- jobs

  _createJob(kind, params) {
    const id = nextId(kind === 'plan' ? 'plan' : 'job');
    const now = Date.now();
    const waitHint = kind === 'plan'
      ? 'about 20 seconds'
      : 'about 3 minutes';
    // Measured on an RTX 4070 Laptop (8GB): YuE 2 base ~15x real time in the
    // shootout benchmarks, ~10.7x on a warm 30s render through this server.
    const durationHint = kind === 'plan'
      ? 'Planning usually takes 3-20 seconds, though a cold start can take up to a minute while the model loads.'
      : 'Rendering runs at roughly 10-15x real time on an 8GB laptop GPU: about 5-8 minutes for 30 seconds of audio, 10-15 minutes for 60 seconds, and 20-27 minutes for a 2 minute track. Do not assume failure before then.';

    return {
      id,
      kind,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      progress: { percent: 0, stage: 'queued' },
      params,
      result: null,
      track: null,
      error: null,
      // Receipts carry their own polling guidance: a `retryAfterMs` integer is
      // routinely ignored by models, while prose survives context summarisation.
      next: `Call the music tool with action="status" and jobId="${id}" in ${waitHint}. ${durationHint}`
    };
  }

  _enqueueJob(job, run) {
    return this.gpuQueue.enqueue(async () => {
      if (job.state === 'cancelled') throw new JobCancelledError();
      job.state = 'running';
      job.progress = { percent: 5, stage: 'running' };
      job.updatedAt = Date.now();
      return await run();
    });
  }

  _trimJobs() {
    if (this.jobs.size <= this.maxJobs) return;
    const finished = [...this.jobs.values()]
      .filter(job => job.state === 'done' || job.state === 'failed' || job.state === 'cancelled')
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.jobs.size > this.maxJobs && finished.length) {
      this.jobs.delete(finished.shift().id);
    }
  }

  startPlanJob(body = {}) {
    const params = this.normalizePlanRequest(body);
    const job = this._createJob('plan', {
      prompt: params.prompt,
      lyrics: params.lyrics,
      cot: params.cot
    });
    this.jobs.set(job.id, job);

    this._enqueueJob(job, () => this._callEngine('plan', params)).then(
      (result) => {
        job.state = 'done';
        job.progress = { percent: 100, stage: 'done' };
        job.result = {
          planId: job.id,
          abcScore: result && result.abc_score ? result.abc_score : null,
          prompt: params.prompt,
          cot: params.cot
        };
        job.updatedAt = Date.now();
        job.next = 'The score is ready. Show it to the user, discuss changes, then call action="generate" with the final abcScore.';
        this._trimJobs();
      },
      (error) => this._failJob(job, error)
    );

    return this.publicJob(job);
  }

  startRenderJob(body = {}) {
    const params = this.normalizeRenderRequest(body);
    const job = this._createJob('render', params);
    this.jobs.set(job.id, job);

    this._enqueueJob(job, () => this._callEngine('render', params)).then(
      (result) => this._completeRender(job, params, result),
      (error) => this._failJob(job, error)
    );

    return this.publicJob(job);
  }

  _completeRender(job, params, result) {
    try {
      const fileName = `${job.id}.wav`;
      fs.writeFileSync(path.join(this.libraryDir, fileName), result.audio_buffer);

      const track = {
        id: job.id,
        title: params.title || 'Untitled',
        model: result.model || params.model,
        durationMs: Math.round((params.durationSeconds || 60) * 1000),
        file: fileName,
        abcScore: result.abc_score || params.abcScore || null,
        createdAt: new Date().toISOString()
      };

      this._appendTrack(track);
      job.track = track;
      job.state = 'done';
      job.progress = { percent: 100, stage: 'done' };
      job.updatedAt = Date.now();
      job.next = 'Playback is ready. Report the track to the user with its title and audioUrl.';
      this._trimJobs();
    } catch (error) {
      this._failJob(job, error);
    }
  }

  _failJob(job, error) {
    if (error instanceof JobCancelledError) {
      job.state = 'cancelled';
      job.updatedAt = Date.now();
      return;
    }
    job.state = 'failed';
    job.error = error && error.message ? error.message : String(error);
    job.progress = { percent: 0, stage: 'failed' };
    job.updatedAt = Date.now();
    job.next = 'The job failed. Read the error, explain it in character, and offer an alternative.';
    console.error(`[Music Service] Job ${job.id} failed: ${job.error}`);
    this._trimJobs();
  }

  getJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw notFound(`No music job with id "${id}".`);
    return this.publicJob(job);
  }

  listJobs() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(job => this.publicJob(job));
  }

  cancelJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw notFound(`No music job with id "${id}".`);

    if (job.state === 'queued') {
      job.state = 'cancelled';
      job.progress = { percent: 0, stage: 'cancelled' };
      job.updatedAt = Date.now();
      return this.publicJob(job);
    }

    if (job.state === 'running') {
      // Honest limitation: the GPU queue has no abort hook and the engine spawns
      // its CLI internally, so the render will keep running to completion.
      return {
        ...this.publicJob(job),
        cancelSupported: false,
        cancelReason: 'The render is already running and cannot be interrupted; it will finish in the background and appear in the library.'
      };
    }

    return { ...this.publicJob(job), cancelSupported: false, cancelReason: `Job already ${job.state}.` };
  }

  // ------------------------------------------------------------------ library

  _indexPath() {
    return path.join(this.libraryDir, 'index.json');
  }

  _readIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._indexPath(), 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  _appendTrack(track) {
    const index = this._readIndex();
    index.unshift(track);
    fs.writeFileSync(this._indexPath(), JSON.stringify(index.slice(0, 200), null, 2));
  }

  _publicTrack(track) {
    return {
      id: track.id,
      title: track.title,
      model: track.model,
      durationMs: track.durationMs,
      abcScore: track.abcScore || null,
      createdAt: track.createdAt,
      audioUrl: `${this.baseUrl()}/v1/audio/music/library/${track.file}`
    };
  }

  listTracks({ query = '', limit = 20 } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    let tracks = this._readIndex();
    if (needle) {
      tracks = tracks.filter((track) => {
        const haystack = `${track.title || ''} ${track.model || ''} ${track.abcScore || ''}`.toLowerCase();
        return haystack.includes(needle);
      });
    }
    const capped = Math.max(1, Math.min(Number(limit) || 20, 50));
    return tracks.slice(0, capped).map(track => this._publicTrack(track));
  }

  /** Absolute path for a library file, or null when the name is not safe/known. */
  resolveTrackFile(fileName) {
    const safe = path.basename(String(fileName || ''));
    if (!/^[A-Za-z0-9_-]+\.wav$/.test(safe)) return null;
    const full = path.join(this.libraryDir, safe);
    return fs.existsSync(full) ? full : null;
  }

  // ------------------------------------------------------------------- public

  publicJob(job) {
    return {
      jobId: job.id,
      kind: job.kind,
      state: job.state,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      progress: job.progress,
      next: job.next,
      plan: job.result
        ? { planId: job.result.planId, abcScore: job.result.abcScore, cot: job.result.cot }
        : undefined,
      track: job.track ? this._publicTrack(job.track) : undefined,
      error: job.error || undefined
    };
  }
}

module.exports = MusicService;
module.exports.JobCancelledError = JobCancelledError;
