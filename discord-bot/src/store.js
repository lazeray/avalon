import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { ROLE_INFO } from '../../shared/roles.js';

// One bot process owns this file. Persist before revealing roles; never silently
// discard unreadable state, since players may already have received their roles.
export class GameStore {
  constructor(file) {
    this.file = file;
    this.games = {};
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !saved.games || typeof saved.games !== 'object' || Array.isArray(saved.games)) {
        throw new Error('Unsupported bot state file.');
      }
      this.games = saved.games;
      let migrated = false;
      // New optional roles default to zero in saved setups. Preserve existing
      // counts and all private assignments, including games already started.
      for (const game of Object.values(this.games)) {
        if (game.config?.counts) {
          for (const role of Object.keys(ROLE_INFO)) {
            if (!Object.hasOwn(game.config.counts, role)) {
              game.config.counts[role] = 0;
              migrated = true;
            }
          }
        }
        // Old games lack creation times: use their start time if known,
        // otherwise start a one-minute grace period and persist it once.
        if (!Number.isFinite(game.createdAt)) {
          game.createdAt = Number.isFinite(game.startedAt) ? game.startedAt : Date.now();
          migrated = true;
        }
      }
      if (migrated) this.persist(this.games);
      chmodSync(file, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  get(guildId) { return structuredClone(this.games[guildId] ?? null); }
  all() { return structuredClone(Object.values(this.games)); }
  set(guildId, game) {
    // Stored records are isolated at the read/write boundaries; only the
    // changed game needs a deep copy, not every other server’s game.
    const next = { ...this.games };
    if (game) next[guildId] = structuredClone(game);
    else delete next[guildId];
    this.persist(next);
  }
  persist(next) {
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, games: next }), { mode: 0o600, flush: true });
      renameSync(temporary, this.file);
    }
    this.games = next;
  }
}
