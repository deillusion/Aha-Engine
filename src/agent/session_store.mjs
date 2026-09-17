import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

async function renameWithRetry(source, target) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await rename(source, target); return; }
    catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await delay(10 + attempt * 5);
    }
  }
  throw lastError;
}

export class AgentSessionStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.liveDir = path.join(this.directory, 'live');
    this.mockDir = path.join(this.directory, 'mock');
    this.writeChains = new Map();
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    await mkdir(this.liveDir, { recursive: true });
    await mkdir(this.mockDir, { recursive: true });
    await this.migrateLegacy();
    return this;
  }

  async migrateLegacy() {
    try {
      const rootFiles = await readdir(this.directory);
      const sessionFiles = rootFiles.filter(name => /^session-[A-Za-z0-9-]+\.json$/.test(name));
      for (const file of sessionFiles) {
        const fullPath = path.join(this.directory, file);
        try {
          const content = await readFile(fullPath, 'utf8');
          const data = JSON.parse(content);
          const targetDir = data.mode === 'mock' ? this.mockDir : this.liveDir;
          const targetPath = path.join(targetDir, file);
          await renameWithRetry(fullPath, targetPath);
        } catch {
          // ignore corrupted or unreadable legacy files during migration
        }
      }
    } catch {
      // directory read failure is ignored
    }
  }

  file(sessionId, mode) {
    if (!/^session-[A-Za-z0-9-]+$/.test(sessionId)) throw new Error('会话 ID 无效');
    if (mode) {
      const sub = mode === 'mock' ? this.mockDir : this.liveDir;
      return path.join(sub, `${sessionId}.json`);
    }
    const livePath = path.join(this.liveDir, `${sessionId}.json`);
    if (existsSync(livePath)) return livePath;
    const mockPath = path.join(this.mockDir, `${sessionId}.json`);
    if (existsSync(mockPath)) return mockPath;
    const rootPath = path.join(this.directory, `${sessionId}.json`);
    if (existsSync(rootPath)) return rootPath;
    return livePath;
  }

  async save(session) {
    await this.init();
    const target = this.file(session.session_id, session.mode);
    const serialized = `${JSON.stringify(session, null, 2)}\n`;
    const previous = this.writeChains.get(target) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const temp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 6)}`;
      await writeFile(temp, serialized, { encoding: 'utf8', flag: 'wx' });
      await renameWithRetry(temp, target);
    });
    this.writeChains.set(target, current);
    try { await current; }
    finally { if (this.writeChains.get(target) === current) this.writeChains.delete(target); }
    return session;
  }

  async get(sessionId) {
    await this.init();
    return JSON.parse(await readFile(this.file(sessionId), 'utf8'));
  }

  async list(mode) {
    await this.init();
    const dirsToScan = [];
    if (!mode || mode === 'all') {
      dirsToScan.push(this.liveDir, this.mockDir, this.directory);
    } else if (mode === 'live') {
      dirsToScan.push(this.liveDir);
    } else if (mode === 'mock') {
      dirsToScan.push(this.mockDir);
    }

    const sessions = [];
    const seenIds = new Set();

    for (const dir of dirsToScan) {
      try {
        const files = (await readdir(dir)).filter(name => /^session-[A-Za-z0-9-]+\.json$/.test(name)).sort();
        for (const file of files) {
          try {
            const data = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
            if (data?.session_id && !seenIds.has(data.session_id)) {
              if (mode && mode !== 'all' && data.mode && data.mode !== mode) {
                continue;
              }
              seenIds.add(data.session_id);
              sessions.push(data);
            }
          } catch {
            /* an interrupted temp write or malformed file is skipped */
          }
        }
      } catch {
        /* directory does not exist or cannot be read */
      }
    }

    return sessions.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  async delete(sessionId) {
    await this.init();
    const target = this.file(sessionId);
    try {
      await unlink(target);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async deleteMany({ mode } = {}) {
    await this.init();
    if (mode === 'mock') {
      try {
        const files = (await readdir(this.mockDir)).filter(name => /^session-[A-Za-z0-9-]+\.json$/.test(name));
        let count = 0;
        for (const file of files) {
          try {
            await unlink(path.join(this.mockDir, file));
            count++;
          } catch {}
        }
        return count;
      } catch {
        return 0;
      }
    }
    return 0;
  }
}
