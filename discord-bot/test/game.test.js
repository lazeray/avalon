import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameStore } from '../src/store.js';
import { setupMessage, setupPages } from '../src/presentation.js';
import { BotGames, roleMessage } from '../src/game.js';
import { emptyCounts, preset } from '../../shared/roles.js';

function fixture(t, { disk = false } = {}) {
  let file;
  if (disk) {
    const dir = mkdtempSync(join(tmpdir(), 'avalon-bot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    file = join(dir, 'games.json');
  }
  const store = new GameStore(file);
  const messages = [];
  const blocked = new Set();
  const sendDM = async (id, content) => {
    if (blocked.has(id)) throw new Error('DM blocked');
    messages.push({ id, content });
  };
  const games = new BotGames({ store, sendDM });
  const create = (guildId = 'guild') => games.run(guildId, () => games.create({ guildId, guildName: 'Test server', channelId: 'channel', user: { id: '0', name: 'Host' } }));
  const act = (action, ...args) => games.run('guild', () => games[action](games.requireGame('guild'), ...args));
  async function full() {
    await create();
    for (let i = 1; i < 6; i++) await act('join', { id: String(i), name: `Player ${i}` });
    messages.length = 0;
  }
  return { file, store, games, messages, blocked, sendDM, create, act, full };
}

test('one game per guild, DM checks, duplicates, host transfer and closing the last seat', async t => {
  const f = fixture(t);
  f.blocked.add('0');
  await assert.rejects(f.create(), /could not DM/);
  assert.equal(f.store.get('guild'), null);
  f.blocked.clear();
  await f.create();
  await assert.rejects(f.create(), /already has/);
  await f.create('other');
  f.blocked.add('1');
  await assert.rejects(f.act('join', { id: '1', name: 'Guest' }), /could not DM/);
  assert.equal(f.store.get('guild').players.length, 1);
  f.blocked.clear();
  await f.act('join', { id: '1', name: 'Guest' });
  const count = f.messages.length;
  await f.act('join', { id: '1', name: 'Guest' });
  assert.equal(f.messages.length, count);
  await f.act('leave', '0');
  assert.equal(f.store.get('guild').hostId, '1');
  await f.act('leave', '1');
  assert.equal(f.store.get('guild'), null);
  assert.ok(f.store.get('other'));
});

test('host restrictions, full seats, validation, locked setup, stale game IDs', async t => {
  const f = fixture(t);
  await f.full();
  for (const action of ['start', 'retry', 'end']) await assert.rejects(f.act(action, '1'), /Only the host/);
  await assert.rejects(f.act('setup', '1', preset()), /Only the host/);
  await assert.rejects(f.act('setup', '0', preset(5)), /more joined/);
  await assert.rejects(f.act('setup', '0', { mode: 'custom', counts: { Spy: -1 } }), /supported roles/);
  await assert.rejects(f.act('join', { id: '7', name: 'Extra' }), /full/);
  assert.throws(() => f.games.requireGame('guild', 'old'), /old game/);
  await f.act('leave', '5');
  await assert.rejects(f.act('start', '0'), /Fill every seat/);
  await f.act('join', { id: '5', name: 'Back' });
  await f.act('start', '0');
  for (const [action, ...args] of [['start', '0'], ['setup', '0', preset()], ['leave', '1'], ['join', { id: '7', name: 'Extra' }]]) {
    await assert.rejects(f.act(action, ...args), /Roles have been dealt/);
  }
});

test('persisted role assignments survive delivery failure, restart and retry without reshuffling', async t => {
  const f = fixture(t, { disk: true });
  await f.full();
  f.blocked.add('2');
  const game = await f.act('start', '0');
  assert.equal(f.messages.length, 5);
  assert.equal(game.delivered.length, 5);
  assert.deepEqual(game.players.map(p => p.role).sort(), ['Resistance', 'Resistance', 'Merlin', 'Percival', 'Assassin', 'Morgana'].sort());
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  const recovered = new BotGames({ store: new GameStore(f.file), sendDM: f.sendDM });
  f.blocked.clear();
  await recovered.run('guild', () => recovered.retry(recovered.requireGame('guild'), '0'));
  assert.deepEqual(recovered.requireGame('guild').players, game.players);
  assert.equal(f.messages.length, 6);
  const retried = f.messages.at(-1);
  assert.equal(retried.id, '2');
  assert.equal(retried.content, roleMessage(game, game.players.find(p => p.id === '2')));
  await recovered.run('guild', () => recovered.retry(recovered.requireGame('guild'), '0'));
  assert.equal(f.messages.length, 6);
  recovered.end(recovered.requireGame('guild'), '0');
  assert.equal(new GameStore(f.file).get('guild'), null);
});

test('assignments are on disk before any role DM and a storage failure prevents revealing roles', async t => {
  const f = fixture(t, { disk: true });
  await f.full();
  f.games.sendDM = async (id, content) => {
    const saved = new GameStore(f.file).get('guild');
    assert.equal(saved.phase, 'started');
    assert.ok(saved.players.every(p => p.role));
    assert.equal(content, roleMessage(saved, saved.players.find(p => p.id === id)));
  };
  await f.act('start', '0');
  await f.act('end', '0');
  f.games.sendDM = f.sendDM;
  await f.full();
  f.store.set = () => { throw new Error('disk full'); };
  await assert.rejects(f.act('start', '0'), /disk full/);
  assert.equal(f.messages.length, 0);
  assert.equal(f.store.get('guild').phase, 'lobby');
});

test('simultaneous guild actions are rejected until DM delivery finishes', async t => {
  const f = fixture(t);
  await f.full();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.games.sendDM = () => pending;
  const starting = f.act('start', '0');
  await assert.rejects(f.act('start', '0'), /Another action/);
  await assert.rejects(f.act('end', '0'), /Another action/);
  release();
  await starting;
  assert.equal(f.store.get('guild').delivered.length, 6);
});

test('custom roles use shared privacy rules in DMs and include stable game IDs', async t => {
  const f = fixture(t);
  await f.create();
  const counts = { ...emptyCounts(), Merlin: 1, Percival: 1, Morgana: 1, Mordred: 1, Oberon: 1, Tristan: 1, Isolde: 1 };
  await f.act('setup', '0', { mode: 'custom', counts });
  for (let i = 1; i < 7; i++) await f.act('join', { id: String(i), name: `Person ${i}` });
  const game = await f.act('start', '0');
  const byRole = Object.fromEntries(game.players.map(p => [p.role, p]));
  const seenIds = role => [...roleMessage(game, byRole[role]).matchAll(/\(ID: (\d+)\)/g)].map(m => m[1]).sort();
  assert.deepEqual(seenIds('Merlin'), [byRole.Morgana.id, byRole.Oberon.id].sort());
  assert.deepEqual(seenIds('Percival'), [byRole.Merlin.id, byRole.Morgana.id].sort());
  assert.deepEqual(seenIds('Oberon'), []);
  assert.deepEqual(seenIds('Tristan'), [byRole.Isolde.id]);
  assert.deepEqual(seenIds('Isolde'), [byRole.Tristan.id]);
  for (const p of game.players) assert.ok(roleMessage(game, p).includes(game.id));
});

test('corrupt or unsupported saved state fails closed', t => {
  const f = fixture(t, { disk: true });
  writeFileSync(f.file, 'not json');
  assert.throws(() => new GameStore(f.file));
  writeFileSync(f.file, JSON.stringify({ version: 2, games: {} }));
  assert.throws(() => new GameStore(f.file), /Unsupported/);
  assert.match(readFileSync(f.file, 'utf8'), /"version":2/);
});

test('leader survives DM retry and restart, and role messages end with a divider', async t => {
  const f = fixture(t, { disk: true });
  await f.full();
  f.blocked.add('2');
  const game = await f.act('start', '0');
  assert.ok(game.players.some(p => p.id === game.leaderId));
  const persisted = new GameStore(f.file).get('guild');
  assert.equal(persisted.leaderId, game.leaderId);
  f.blocked.clear();
  assert.equal((await f.act('retry', '0')).leaderId, game.leaderId);
  const message = roleMessage(game, game.players[0]);
  assert.ok(message.endsWith('────────────────────'));
  assert.ok(!message.includes('Keep this message private'));
});

test('Fool random information persists before DMs and survives failed delivery and restart', async t => {
  const f = fixture(t, { disk: true });
  await f.full();
  await f.act('setup', '0', { mode: 'custom', counts: { ...emptyCounts(), Fool: 1, Merlin: 1, Percival: 1, Resistance: 1, Spy: 1, Morgana: 1 } });
  for (let i = 0; i < 6; i++) f.blocked.add(String(i));
  const game = await f.act('start', '0');
  const fool = game.players.find(p => p.role === 'Fool');
  const expected = roleMessage(game, fool);
  assert.equal(fool.foolSeenIds.length, 2);
  const recovered = new BotGames({ store: new GameStore(f.file), sendDM: f.sendDM });
  assert.deepEqual(recovered.requireGame('guild').players, game.players);
  f.blocked.clear();
  await recovered.run('guild', () => recovered.retry(recovered.requireGame('guild'), '0'));
  assert.equal(f.messages.find(m => m.id === fool.id).content, expected);
  assert.match(expected, /Your role: Merlin/);
  assert.ok(!expected.includes('Fool'));
});

test('legacy saved games gain a zero Fool count without changing assignments or delivery state', async t => {
  const f = fixture(t, { disk: true });
  await f.full();
  const game = await f.act('start', '0');
  const legacy = JSON.parse(readFileSync(f.file, 'utf8'));
  delete legacy.games.guild.config.counts.Fool;
  writeFileSync(f.file, JSON.stringify(legacy));
  const restored = new GameStore(f.file).get('guild');
  assert.equal(restored.config.counts.Fool, 0);
  assert.deepEqual(restored.players, game.players);
  assert.deepEqual(restored.delivered, game.delivered);
});

test('any server member can end a lobby at one minute, including after restart', async t => {
  const f = fixture(t, { disk: true });
  let now = 1_000_000;
  f.games.now = () => now;
  await f.create();
  assert.equal(f.store.get('guild').createdAt, now);
  now += 59_999;
  await assert.rejects(f.act('end', 'non-player'), /first minute/);
  const recovered = new BotGames({ store: new GameStore(f.file), sendDM: f.sendDM, now: () => now });
  now++;
  assert.equal(recovered.end(recovered.requireGame('guild'), 'non-player').phase, 'ended');
  assert.equal(new GameStore(f.file).get('guild'), null);
});

test('starting and retrying do not reset the creation timer; hosts can end immediately', async t => {
  const f = fixture(t);
  let now = 1_000_000;
  f.games.now = () => now;
  await f.create();
  assert.equal((await f.act('end', '0')).phase, 'ended');
  await f.full();
  now += 60_000;
  await f.act('start', '0');
  await f.act('retry', '0');
  assert.equal((await f.act('end', 'non-player')).phase, 'ended');
  await f.full();
  await f.act('start', '0');
  await assert.rejects(f.act('end', 'non-player'), /first minute/);
  assert.equal((await f.act('end', '0')).phase, 'ended');
});

test('legacy creation timers are migrated once and persist across restarts', async t => {
  const f = fixture(t, { disk: true });
  await f.create();
  const legacy = JSON.parse(readFileSync(f.file, 'utf8'));
  delete legacy.games.guild.createdAt;
  writeFileSync(f.file, JSON.stringify(legacy));
  const before = Date.now();
  const restored = new GameStore(f.file).get('guild');
  assert.ok(restored.createdAt >= before && restored.createdAt <= Date.now());
  assert.equal(new GameStore(f.file).get('guild').createdAt, restored.createdAt);
  const recovered = new BotGames({ store: new GameStore(f.file), sendDM: f.sendDM, now: () => restored.createdAt + 60_000 });
  recovered.end(recovered.requireGame('guild'), 'non-player');
  legacy.games.guild.phase = 'started';
  legacy.games.guild.startedAt = before - 120_000;
  writeFileSync(f.file, JSON.stringify(legacy));
  assert.equal(new GameStore(f.file).get('guild').createdAt, legacy.games.guild.startedAt);
});

test('store isolates input and output objects and keeps state intact on a failed write', t => {
  const f = fixture(t, { disk: true });
  const game = { guildId: 'a', createdAt: 1, config: preset(), players: [{ id: '1', name: 'Original' }] };
  f.store.set('a', game);
  f.store.set('b', { ...game, guildId: 'b' });
  game.players[0].name = 'Input changed';
  f.store.get('a').players[0].name = 'Read changed';
  f.store.all()[0].config.counts.Merlin = 9;
  const before = f.store.all();
  assert.equal(before[0].players[0].name, 'Original');
  assert.equal(before[0].config.counts.Merlin, 1);
  // A regular file cannot be used as the parent directory of a state file.
  f.store.file = join(f.file, 'invalid.json');
  assert.throws(() => f.store.set('a', game));
  assert.throws(() => f.store.set('b', null));
  assert.deepEqual(f.store.all(), before);
  f.store.file = f.file;
  assert.deepEqual(new GameStore(f.file).all(), before);
  f.store.set('a', { ...game, players: [] });
  assert.equal(f.store.get('b').players[0].name, 'Original');
});

test('startup migrates every saved guild in a single write and skips writes on the next load', t => {
  const f = fixture(t, { disk: true });
  const a = { guildId: 'a', config: preset(), players: [] };
  const b = { guildId: 'b', createdAt: 123, config: preset(), players: [] };
  delete a.config.counts.Fool;
  delete b.config.counts.Fool;
  writeFileSync(f.file, JSON.stringify({ version: 1, games: { a, b } }));
  let writes = 0;
  class CountingStore extends GameStore {
    persist(next) { writes++; super.persist(next); }
  }
  const migrated = new CountingStore(f.file);
  assert.equal(writes, 1);
  assert.equal(migrated.get('a').config.counts.Fool, 0);
  assert.equal(migrated.get('b').config.counts.Fool, 0);
  assert.ok(Number.isFinite(migrated.get('a').createdAt));
  assert.equal(migrated.get('b').createdAt, 123);
  const restored = new CountingStore(f.file);
  assert.equal(writes, 1);
  assert.deepEqual(restored.all(), migrated.all());
});

test('pre-Edmund lobbies gain zero counts and can be edited and started without resetting setup', async t => {
  const f = fixture(t, { disk: true });
  await f.full();
  const config = { mode: 'custom', counts: { ...emptyCounts(), Resistance: 3, Merlin: 1, Fool: 1, Spy: 1 } };
  await f.act('setup', '0', config);
  const before = f.store.get('guild');
  const legacy = JSON.parse(readFileSync(f.file, 'utf8'));
  delete legacy.games.guild.config.counts.Edmund;
  writeFileSync(f.file, JSON.stringify(legacy));
  const recovered = new BotGames({ store: new GameStore(f.file), sendDM: f.sendDM });
  const game = recovered.requireGame('guild');
  assert.deepEqual(game, before);
  assert.deepEqual(new GameStore(f.file).get('guild'), before);
  const pages = setupPages().map((_, page) => JSON.stringify(setupMessage(game, null, page)));
  assert.ok(pages.some(page => page.includes('### Edmund: 0')));
  assert.ok(pages.every(page => !page.includes('undefined')));
  // The migrated zero makes the existing +/- editor's arithmetic valid.
  const edited = structuredClone(game.config);
  edited.counts.Edmund++;
  edited.counts.Spy--;
  recovered.setup(game, '0', edited);
  const started = await recovered.start(recovered.requireGame('guild'), '0');
  assert.equal(started.players.filter(p => p.role === 'Edmund').length, 1);
  assert.equal(started.createdAt, before.createdAt);
  assert.equal(started.delivered.length, 6);
});

test('pre-Edmund started games retain roles, Fool knowledge, and pending DMs after migration', async t => {
  const f = fixture(t, { disk: true });
  await f.full();
  await f.act('setup', '0', { mode: 'custom', counts: { ...emptyCounts(), Resistance: 3, Merlin: 1, Fool: 1, Spy: 1 } });
  f.blocked.add('2');
  const before = await f.act('start', '0');
  const legacy = JSON.parse(readFileSync(f.file, 'utf8'));
  delete legacy.games.guild.config.counts.Edmund;
  writeFileSync(f.file, JSON.stringify(legacy));
  const recovered = new BotGames({ store: new GameStore(f.file), sendDM: f.sendDM });
  assert.deepEqual(recovered.requireGame('guild'), before);
  const count = f.messages.length;
  f.blocked.clear();
  const retried = await recovered.retry(recovered.requireGame('guild'), '0');
  assert.deepEqual(retried.players, before.players);
  assert.equal(retried.createdAt, before.createdAt);
  assert.equal(retried.startedAt, before.startedAt);
  assert.equal(f.messages.length, count + 1);
  assert.equal(f.messages.at(-1).content, roleMessage(before, before.players.find(p => p.id === '2')));
});
