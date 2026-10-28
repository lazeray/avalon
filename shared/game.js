import { randomInt } from 'node:crypto';
import { ROLE_INFO, totals, validateConfig } from './roles.js';

export function startingInformation(me, players) {
  if (!me.role) return null;
  const edmunds = players.filter(p => p.role === 'Edmund');
  // Resolve saved targets only; reads must never choose or reroll a frame.
  const framedPlayers = edmunds.map(edmund => framedPlayer(edmund, players));
  let visible = [];
  let heading = 'No players revealed';
  let explanation = 'Your role gives you no information about other players.';
  if (me.role === 'Merlin' || me.role === 'Fool') {
    if (me.role === 'Fool') {
      if (!Array.isArray(me.foolSeenIds)) throw new Error('Missing saved Fool information.');
      visible = players.filter(p => me.foolSeenIds.includes(p.id));
    } else {
      const framedIds = new Set(framedPlayers.filter(Boolean).map(p => p.id));
      visible = players.filter(p => (ROLE_INFO[p.role].team === 'Spy' && p.role !== 'Mordred') || framedIds.has(p.id));
    }
    heading = 'Known spies';
    explanation = 'Mordred is hidden from you. These players are spies; their exact roles are not revealed.';
    // Give Fool exactly the same text as Merlin; framing must not reveal its disguise.
    if (edmunds.length) explanation = 'Mordred is hidden from you. These players appear as spies; some may be framed Resistance players. Exact roles are not revealed.';
  } else if (me.role === 'Percival') {
    visible = players.filter(p => p.role === 'Merlin' || p.role === 'Morgana');
    heading = 'Possible Merlins';
    explanation = 'These players are Merlin or Morgana. You cannot tell their roles apart from this reveal.';
    if (!visible.some(p => p.role === 'Morgana')) {
      heading = 'Merlin';
      explanation = 'No Morgana is in this game, so every revealed player is Merlin.';
    } else if (!visible.some(p => p.role === 'Merlin')) {
      heading = 'Morgana';
      explanation = 'No Merlin is in this custom setup, so every revealed player is Morgana.';
    }
  } else if (me.role === 'Tristan' || me.role === 'Isolde') {
    const partner = me.role === 'Tristan' ? 'Isolde' : 'Tristan';
    visible = players.filter(p => p.role === partner);
    heading = partner;
    explanation = `You know every ${partner} in this setup.`;
  } else if (me.role === 'Oberon') {
    explanation = 'You are a spy, but you do not see your teammates and they do not see you. Merlin can see you.';
  } else if (ROLE_INFO[me.role].team === 'Spy') {
    visible = players.filter(p => p.id !== me.id && ROLE_INFO[p.role].team === 'Spy' && p.role !== 'Oberon');
    heading = 'Known spy teammates';
    explanation = 'Oberon is hidden from your team. Exact teammate roles are not revealed.';
    if (me.role === 'Edmund') {
      const target = framedPlayer(me, players);
      // Keep the framed good player out of the spy-teammate list: existing clients
      // use that list to mark spies. Seat and ID identify the frame in both clients.
      explanation += target
        ? ` You framed the player in seat ${players.findIndex(p => p.id === target.id) + 1} (ID: ${target.id}). They remain Resistance but appear as a spy to Merlin. They are not a spy teammate.`
        : ' No Resistance player exists, so you framed nobody.';
      return { heading, explanation, players: visible.map(p => ({ id: p.id, name: p.name })),
        framedPlayer: target ? { id: target.id, name: target.name } : null };
    }
  }
  // Preserve public seat order, never group or sort candidates by their hidden roles.
  return { heading, explanation, players: visible.map(p => ({ id: p.id, name: p.name })) };
}

function framedPlayer(edmund, players) {
  if (!Object.hasOwn(edmund, 'edmundTargetId')) throw new Error('Missing saved Edmund information.');
  if (edmund.edmundTargetId === null) return null;
  const target = players.find(p => p.id === edmund.edmundTargetId);
  if (!target || ROLE_INFO[target.role]?.team !== 'Resistance') {
    throw new Error('Invalid saved Edmund target.');
  }
  return target;
}

export function assignRoles(players, config) {
  const error = validateConfig(config);
  if (error) throw new Error(error);
  if (players.length !== totals(config).total) throw new Error('Fill every seat before starting.');
  const roles = Object.entries(config.counts).flatMap(([role, count]) => Array(count).fill(role));
  for (let i = roles.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  const assigned = players.map((player, index) => ({ ...player, role: roles[index] }));
  assignFoolKnowledge(assigned);
  return assigned;
}

export function chooseLeader(players) {
  if (!players.length) throw new Error('A leader needs at least one player.');
  return players[randomInt(players.length)].id;
}

// Only the perceived role is sent to a player's browser or used in their DM.
export function perceivedRole(player) {
  return player.role === 'Fool' ? 'Merlin' : player.role ?? null;
}

export function randomPlayerIds(players, excludedId, count) {
  const candidates = players.filter(player => player.id !== excludedId);
  if (!Number.isInteger(count) || count < 0 || count > candidates.length) {
    throw new Error('Choose a random reveal count within the available players.');
  }
  for (let i = 0; i < count; i++) {
    const j = randomInt(i, candidates.length);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, count).map(player => player.id);
}

// Draw once, after roles are final. Each Edmund draws independently; multiple
// Edmunds may frame the same player. No eligible player means no frame (null).
// Any Resistance role is eligible, including Merlin (who then sees themself).
export function assignEdmundKnowledge(players) {
  const candidates = players.filter(p => ROLE_INFO[p.role].team === 'Resistance');
  for (const player of players) {
    delete player.edmundTargetId;
    if (player.role === 'Edmund') {
      player.edmundTargetId = candidates.length ? candidates[randomInt(candidates.length)].id : null;
    }
  }
}

// Existing clients call this after finalizing roles (including demo role swaps).
// Keep that entry point and finalize both kinds of private random knowledge here.
// Never call it while reading information, retrying DMs, or reconnecting a player.
export function assignFoolKnowledge(players) {
  assignEdmundKnowledge(players);
  const spyCount = players.filter(p => ROLE_INFO[p.role].team === 'Spy').length;
  const edmundCount = players.filter(p => p.role === 'Edmund').length;
  const revealCount = Math.min(spyCount + edmundCount, Math.max(0, players.length - 1));
  for (const player of players) {
    delete player.foolSeenIds;
    if (player.role === 'Fool') player.foolSeenIds = randomPlayerIds(players, player.id, revealCount);
  }
}
