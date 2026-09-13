import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.liveDir = path.join(dir, 'live');
    this.mockDir = path.join(dir, 'mock');
    this.queues = new Map();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.liveDir, { recursive: true });
    await mkdir(this.mockDir, { recursive: true });
    await this.migrateLegacy();
  }

  async migrateLegacy() {
    try {
      const rootFiles = await readdir(this.dir);
      const runFiles = rootFiles.filter(f => /^run-[a-zA-Z0-9-]+\.json$/.test(f));
      for (const f of runFiles) {
        const fullPath = path.join(this.dir, f);
        try {
          const content = await readFile(fullPath, 'utf8');
          const data = JSON.parse(content);
          const targetDir = data.mode === 'mock' ? this.mockDir : this.liveDir;
          const targetPath = path.join(targetDir, f);
          await rename(fullPath, targetPath);

          const baseName = f.slice(0, -5);
          for (const ext of ['.tmp', '.audit.json', '.answer.md', '.review.md']) {
            const aux = `${baseName}${ext}`;
            const auxFull = path.join(this.dir, aux);
            if (existsSync(auxFull)) {
              await rename(auxFull, path.join(targetDir, aux)).catch(() => {});
            }
          }
        } catch {}
      }
    } catch {}
  }

  file(id, mode) {
    if (!/^run-[a-zA-Z0-9-]+$/.test(id)) throw new Error('无效运行 ID');
    if (mode) {
      const sub = mode === 'mock' ? 'mock' : 'live';
      return path.join(this.dir, sub, `${id}.json`);
    }
    const livePath = path.join(this.liveDir, `${id}.json`);
    if (existsSync(livePath)) return livePath;
    const mockPath = path.join(this.mockDir, `${id}.json`);
    if (existsSync(mockPath)) return mockPath;
    const rootPath = path.join(this.dir, `${id}.json`);
    if (existsSync(rootPath)) return rootPath;
    return livePath;
  }

  async save(run) {
    const targetMode = run.mode === 'mock' ? 'mock' : 'live';
    const file = this.file(run.id, targetMode);
    const text = JSON.stringify(run);
    const job = (this.queues.get(run.id) ?? Promise.resolve()).then(async () => {
      await writeFile(`${file}.tmp`, text, 'utf8');
      for (let attempt = 0; ; attempt++) {
        try { await rename(`${file}.tmp`, file); break; }
        catch (e) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 5) throw e; await delay(20 * (attempt + 1)); }
      }
    });
    this.queues.set(run.id, job.catch(() => {}));
    await job;
  }

  async get(id) {
    const file = this.file(id);
    // Windows can reject replacement while readFile has the destination open.
    // Serialize reads with writes as well as writes with each other.
    const job = (this.queues.get(id) ?? Promise.resolve()).then(async () => JSON.parse(await readFile(file, 'utf8')));
    this.queues.set(id, job.then(() => {}, () => {}));
    return job;
  }

  async list(mode) {
    const dirsToScan = [];
    if (mode === 'live') {
      dirsToScan.push(this.liveDir);
    } else if (mode === 'mock') {
      dirsToScan.push(this.mockDir);
    } else {
      dirsToScan.push(this.liveDir, this.mockDir, this.dir);
    }

    const seen = new Set();
    const allIds = [];
    for (const d of dirsToScan) {
      try {
        const entries = await readdir(d);
        for (const f of entries) {
          if (/^run-[a-zA-Z0-9-]+\.json$/.test(f)) {
            const id = f.slice(0, -5);
            if (!seen.has(id)) {
              seen.add(id);
              allIds.push(id);
            }
          }
        }
      } catch {}
    }

    const results = await Promise.allSettled(allIds.map(id => this.get(id)));
    return results
      .flatMap(r => r.status === 'fulfilled' ? [summary(r.value)] : [])
      .filter(r => !mode || mode === 'all' || r.mode === mode)
      .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  }

  async recover() {
    for (const s of await this.list()) {
      if (s.status === 'running') {
        const run = await this.get(s.id);
        run.status = 'interrupted';
        run.error = '服务重启中断了此次运行；可保留记录并重新发起。';
        run.completed_at = new Date().toISOString();
        await this.save(run);
      }
    }
  }
}

export function summary(r) {
  return {
    id: r.id,
    workflow_version: r.workflow_version ?? 1,
    problem: r.problem,
    mode: r.mode,
    experiment: r.experiment,
    use_operators: r.use_operators,
    status: r.status,
    phase: r.phase,
    round: r.round,
    started_at: r.started_at,
    completed_at: r.completed_at,
    metrics: r.metrics,
    final_available: !!r.final,
    seed: r.seed
  };
}
