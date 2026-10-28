import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { assignRoles, assignFoolKnowledge, assignEdmundKnowledge, startingInformation, perceivedRole } from './game.js';
import { emptyCounts, preset, ROLE_INFO, totals, validateConfig } from './roles.js';
import { BotGames, roleMessage } from '../discord-bot/src/game.js';
import { GameStore } from '../discord-bot/src/store.js';
import { createGameServer } from '../web/server.js';

const playersFor = roles => roles.map((role, i) => ({ id: String(i), name: `Player ${i}`, role }));
const seen = (player, players) => startingInformation(player, players).players.map(p => p.id);

test('Edmund is an optional Spy role, counted and assigned through the shared setup API', () => {
  assert.equal(ROLE_INFO.Edmund.team, 'Spy');
  for (const size of [5, 6, 7, 8, 9, 10, 15]) {
    assert.equal(preset(size).counts.Edmund, 0);
    assert.equal(totals(preset(size)).total, size);
  }
  const config = { mode: 'custom', counts: { ...emptyCounts(), Edmund: 1, Merlin: 1, Resistance: 1 } };
  assert.equal(validateConfig(config), null);
  assert.deepEqual(totals(config), { total: 3, Resistance: 2, Spy: 1 });
  const assigned = assignRoles(playersFor(['Resistance', 'Resistance', 'Resistance']), config);
  const edmund = assigned.find(p => p.role === 'Edmund');
  const target = assigned.find(p => p.id === edmund.edmundTargetId);
  assert.equal(ROLE_INFO[target.role].team, 'Resistance');
  assert.equal(perceivedRole(edmund), 'Edmund');
});

test('Edmund can draw every Resistance role, including Merlin, but never an evil role', () => {
  for (const eligibleRole of Object.keys(ROLE_INFO).filter(role => ROLE_INFO[role].team === 'Resistance')) {
    const players = playersFor(['Edmund', 'Assassin', 'Morgana', 'Spy', 'Mordred', 'Oberon', eligibleRole]);
    assignFoolKnowledge(players);
    assert.equal(players[0].edmundTargetId, '6');
    assert.equal(players[6].role, eligibleRole);
    for (const merlin of players.filter(p => p.role === 'Merlin')) {
      assert.deepEqual(seen(merlin, players), ['0', '1', '2', '3', '5', '6']);
    }
  }
  const players = playersFor(['Edmund', 'Merlin', 'Spy', 'Resistance', 'Percival']);
  assignEdmundKnowledge(players);
  assert.ok(['1', '3', '4'].includes(players[0].edmundTargetId));
});

test('a saved Merlin frame reveals Merlin to themself and other Merlins, including in Discord DMs', () => {
  const players = playersFor(['Edmund', 'Merlin', 'Merlin', 'Mordred', 'Percival']);
  assignEdmundKnowledge(players);
  players[0].edmundTargetId = '1';
  const restored = JSON.parse(JSON.stringify(players));
  for (const merlin of restored.filter(p => p.role === 'Merlin')) {
    assert.deepEqual(seen(merlin, restored), ['0', '1']);
  }
  assert.deepEqual(startingInformation(restored[0], restored).framedPlayer, { id: '1', name: 'Player 1' });
  assert.deepEqual(seen(restored[4], restored), ['1', '2']);
  assert.equal(restored[1].role, 'Merlin');
  assert.match(roleMessage({ players: restored }, restored[1]), /Player 1/);
  assert.deepEqual(restored, players);
});

test('only Merlin gains the actual framed player; the Edmund knows the target, not their exact role', () => {
  const players = playersFor(['Edmund', 'Merlin', 'Percival', 'Morgana', 'Mordred', 'Oberon', 'Tristan', 'Isolde', 'Resistance']);
  assignEdmundKnowledge(players);
  players[0].edmundTargetId = '8';
  assert.deepEqual(seen(players[1], players), ['0', '3', '5', '8']);
  assert.deepEqual(seen(players[2], players), ['1', '3']);
  assert.deepEqual(seen(players[3], players), ['0', '4']);
  assert.deepEqual(seen(players[4], players), ['0', '3']);
  assert.deepEqual(seen(players[5], players), []);
  assert.deepEqual(seen(players[6], players), ['7']);
  assert.deepEqual(seen(players[7], players), ['6']);
  assert.deepEqual(seen(players[8], players), []);
  const edmundInfo = startingInformation(players[0], players);
  assert.deepEqual(edmundInfo.players.map(p => p.id), ['3', '4']);
  assert.deepEqual(edmundInfo.framedPlayer, { id: '8', name: 'Player 8' });
  assert.match(edmundInfo.explanation, /seat 9 \(ID: 8\)/);
  for (const player of players.slice(1)) {
    const info = startingInformation(player, players);
    assert.ok(!Object.hasOwn(info, 'framedPlayer'));
    assert.ok(info.players.every(p => Object.keys(p).sort().join(',') === 'id,name'));
  }
});

test('multiple Edmunds draw independently and duplicate targets appear once in public seat order', () => {
  const players = playersFor(['Merlin', 'Edmund', 'Spy', 'Edmund', 'Mordred']);
  assignEdmundKnowledge(players);
  assert.equal(players[1].edmundTargetId, '0');
  assert.equal(players[3].edmundTargetId, '0');
  assert.deepEqual(seen(players[0], players), ['0', '1', '2', '3']);
  assert.deepEqual(startingInformation(players[1], players).framedPlayer, { id: '0', name: 'Player 0' });
  assert.deepEqual(startingInformation(players[3], players).framedPlayer, { id: '0', name: 'Player 0' });
});

test('no good player means no frame in all-evil setups', () => {
  for (const roles of [['Edmund'], ['Edmund', 'Spy'], ['Edmund', 'Mordred']]) {
    const players = playersFor(roles);
    assignFoolKnowledge(players);
    assert.equal(players[0].edmundTargetId, null);
    const info = startingInformation(players[0], players);
    assert.equal(info.framedPlayer, null);
    assert.match(info.explanation, /No Resistance player/);
  }
});

test('Fool gets one extra random suspect per Edmund, excluding self and duplicates, capped at other seats', () => {
  for (const roles of [
    ['Fool', 'Resistance'],
    ['Fool', 'Edmund', 'Resistance', 'Resistance'],
    ['Fool', 'Edmund', 'Edmund', 'Resistance', 'Resistance', 'Resistance'],
    ['Fool', 'Edmund'],
    ['Fool', 'Edmund', 'Edmund', 'Spy'],
  ]) {
    const players = playersFor(roles);
    assignFoolKnowledge(players);
    const fool = players[0];
    const spyCount = players.filter(p => ROLE_INFO[p.role].team === 'Spy').length;
    const edmundCount = players.filter(p => p.role === 'Edmund').length;
    const expected = Math.min(spyCount + edmundCount, players.length - 1);
    assert.equal(fool.foolSeenIds.length, expected);
    assert.equal(new Set(fool.foolSeenIds).size, expected);
    assert.ok(!fool.foolSeenIds.includes(fool.id));
    assert.equal(seen(fool, players).length, expected);
    assert.equal(perceivedRole(fool), 'Merlin');
  }
});

test('Fool reveal is independent of actual frames, and uses the same explanation as Merlin', () => {
  const players = playersFor(['Fool', 'Merlin', 'Edmund', 'Percival', 'Resistance', 'Resistance']);
  assignFoolKnowledge(players);
  const saved = [...players[0].foolSeenIds];
  const before = startingInformation(players[0], players);
  players[2].edmundTargetId = '4';
  assert.deepEqual(startingInformation(players[0], players), before);
  players[2].edmundTargetId = '5';
  assert.deepEqual(players[0].foolSeenIds, saved);
  assert.deepEqual(startingInformation(players[0], players), before);
  assert.equal(before.explanation, startingInformation(players[1], players).explanation);
  assert.deepEqual(seen(players[3], players), ['1']);
});

test('reading information never rerolls saved frames or Fool information', () => {
  const players = playersFor(['Edmund', 'Edmund', 'Merlin', 'Fool', 'Resistance', 'Resistance']);
  assignFoolKnowledge(players);
  const saved = structuredClone(players);
  const info = players.map(p => startingInformation(p, players));
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(players.map(p => startingInformation(p, players)), info);
    assert.deepEqual(players, saved);
  }
});

test('redealing clears stale private fields, and the existing post-swap hook finalizes legal targets', () => {
  const original = playersFor(['Edmund', 'Fool', 'Resistance']);
  assignFoolKnowledge(original);
  const redealt = assignRoles(original, { mode: 'custom', counts: { ...emptyCounts(), Resistance: 3 } });
  assert.ok(redealt.every(p => !Object.hasOwn(p, 'edmundTargetId') && !Object.hasOwn(p, 'foolSeenIds')));
  const swapped = playersFor(['Edmund', 'Spy', 'Merlin']);
  assignFoolKnowledge(swapped);
  assert.equal(swapped[0].edmundTargetId, '2');
  [swapped[1].role, swapped[2].role] = [swapped[2].role, swapped[1].role];
  assignFoolKnowledge(swapped); // Same entry point used by the existing web demo.
  assert.equal(swapped[0].edmundTargetId, '1');
});

test('missing or invalid saved Edmund data fails instead of inventing starting knowledge', () => {
  const players = playersFor(['Edmund', 'Merlin', 'Resistance']);
  assert.throws(() => startingInformation(players[1], players), /Missing saved Edmund/);
  players[0].edmundTargetId = '0';
  assert.throws(() => startingInformation(players[1], players), /Invalid saved Edmund/);
  players[0].edmundTargetId = 'missing';
  assert.throws(() => startingInformation(players[0], players), /Invalid saved Edmund/);
});

test('unchanged Discord delivery saves Edmund and Fool knowledge before DMs, then preserves it through retry/restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'avalon-edmund-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'games.json');
  const store = new GameStore(file);
  const messages = [];
  const blocked = new Set();
  const sendDM = async (id, content) => {
    if (blocked.has(id)) throw new Error('DM blocked');
    const saved = new GameStore(file).get('guild');
    if (saved?.phase === 'started') {
      assert.ok(saved.players.find(p => p.role === 'Edmund').edmundTargetId);
      assert.equal(saved.players.find(p => p.role === 'Fool').foolSeenIds.length, 2);
      assert.equal(content, roleMessage(saved, saved.players.find(p => p.id === id)));
    }
    messages.push({ id, content });
  };
  const games = new BotGames({ store, sendDM });
  let game = await games.create({ guildId: 'guild', guildName: 'Test', channelId: 'channel', user: { id: '0', name: 'Host' } });
  game = games.setup(game, '0', { mode: 'custom', counts: { ...emptyCounts(), Edmund: 1, Merlin: 1, Fool: 1, Resistance: 2 } });
  for (let i = 1; i < 5; i++) game = await games.join(game, { id: String(i), name: `Player ${i}` });
  messages.length = 0;
  for (let i = 0; i < 5; i++) blocked.add(String(i));
  game = await games.start(game, '0');
  assert.equal(game.phase, 'started'); // Edmund requires no extra game stage.
  assert.equal(messages.length, 0);
  const saved = structuredClone(game.players);
  const recovered = new BotGames({ store: new GameStore(file), sendDM });
  blocked.clear();
  const retried = await recovered.retry(recovered.requireGame('guild'), '0');
  assert.deepEqual(retried.players, saved);
  assert.equal(messages.length, 5);
  const edmund = retried.players.find(p => p.role === 'Edmund');
  assert.match(messages.find(m => m.id === edmund.id).content, new RegExp(`You framed the player in seat \\d+ \\(ID: ${edmund.edmundTargetId}\\)`));
  const fool = retried.players.find(p => p.role === 'Fool');
  assert.match(messages.find(m => m.id === fool.id).content, /Your role: Merlin/);
  await recovered.retry(recovered.requireGame('guild'), '0');
  assert.equal(messages.length, 5);
});

test('unchanged web API reveals frames privately, preserves reconnects and supports Fool extras and reset', async t => {
  const server = createGameServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (path = '/api/state', body) => {
      const response = await fetch(url + path, {
        method: path === '/api/state' ? 'GET' : 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      assert.equal(response.status, 200);
      return response.json();
    };
  };
  const clients = Array.from({ length: 6 }, client);
  for (const [i, call] of clients.entries()) await call('/api/join', { name: `Player ${i}` });
  await clients[0]('/api/config', { mode: 'custom', counts: { ...emptyCounts(), Edmund: 1, Merlin: 1, Morgana: 1, Mordred: 1, Percival: 1, Resistance: 1 } });
  await clients[0]('/api/start');
  const states = await Promise.all(clients.map(call => call()));
  const all = states.map(state => state.me);
  const edmund = all.find(p => p.role === 'Edmund');
  const target = all.find(p => p.id === edmund.information.framedPlayer.id);
  assert.equal(target.team, 'Resistance');
  const merlin = all.find(p => p.role === 'Merlin');
  const expectedIds = all.filter(p => ['Edmund', 'Morgana'].includes(p.role) || p.id === target.id).map(p => p.id);
  assert.deepEqual(merlin.information.players.map(p => p.id), expectedIds);
  assert.deepEqual(edmund.information.players.map(p => p.id), all.filter(p => ['Morgana', 'Mordred'].includes(p.role)).map(p => p.id));
  assert.deepEqual(all.find(p => p.role === 'Percival').information.players.map(p => p.id), all.filter(p => ['Merlin', 'Morgana'].includes(p.role)).map(p => p.id));
  for (const state of states) {
    assert.ok(state.players.every(p => Object.keys(p).sort().join(',') === 'connected,id,name,npc'));
    assert.ok(!JSON.stringify(state).includes('edmundTargetId'));
    if (state.me.role !== 'Edmund') assert.ok(!Object.hasOwn(state.me.information, 'framedPlayer'));
  }
  const observer = await client()();
  assert.equal(observer.me, null);
  assert.ok(!JSON.stringify(observer).includes('framedPlayer'));
  for (const [i, call] of clients.entries()) assert.deepEqual((await call()).me, states[i].me);
  await clients[0]('/api/reset');
  for (const call of clients) {
    const state = await call();
    assert.equal(state.me.role, null);
    assert.equal(state.me.information, null);
  }
  await clients[0]('/api/config', { mode: 'custom', counts: { ...emptyCounts(), Edmund: 2, Fool: 1, Percival: 1, Resistance: 2 } });
  await clients[0]('/api/start');
  const redealt = await Promise.all(clients.map(call => call()));
  const fool = redealt.find(state => state.me.role === 'Merlin').me; // No real Merlin in this setup.
  assert.equal(fool.information.players.length, 4);
  assert.ok(fool.information.players.every(p => p.id !== fool.id));
  assert.ok(!JSON.stringify(redealt).includes('foolSeenIds'));
  assert.deepEqual(redealt.find(state => state.me.role === 'Percival').me.information.players, []);
});
