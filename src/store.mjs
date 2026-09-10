import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export class Store {
  constructor(dir) { this.dir = dir; this.queues = new Map(); }
  async init() { await mkdir(this.dir, { recursive: true }); }
  file(id) { if (!/^run-[a-zA-Z0-9-]+$/.test(id)) throw new Error('无效运行 ID'); return path.join(this.dir, `${id}.json`); }
  async save(run) {
    const file = this.file(run.id), text = JSON.stringify(run);
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
  async list() {
    const files = (await readdir(this.dir)).filter(f => /^run-[a-zA-Z0-9-]+\.json$/.test(f));
    const results = await Promise.allSettled(files.map(f => this.get(f.slice(0, -5))));
    return results.flatMap(r => r.status === 'fulfilled' ? [summary(r.value)] : []).sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
  async recover() { for (const s of await this.list()) if (s.status === 'running') { const run = await this.get(s.id); run.status = 'interrupted'; run.error = '服务重启中断了此次运行；可保留记录并重新发起。'; run.completed_at = new Date().toISOString(); await this.save(run); } }
}
export function summary(r) { return { id: r.id, workflow_version: r.workflow_version ?? 1, problem: r.problem, mode: r.mode, experiment: r.experiment, use_operators: r.use_operators, status: r.status, phase: r.phase, round: r.round, started_at: r.started_at, completed_at: r.completed_at, metrics: r.metrics, final_available: !!r.final, seed: r.seed }; }
