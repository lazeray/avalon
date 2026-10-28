// Shared public setup rules. Player assignments and private knowledge stay on the server.
export const ROLE_INFO = {
  Resistance: { team: 'Resistance', description: 'No starting information.' },
  Merlin: { team: 'Resistance', description: 'Sees spies except Mordred. Framed players also appear as spies.' },
  Fool: { team: 'Resistance', description: 'Believes they are Merlin. Sees a fixed random selection of other players as spies: total Spy count plus one per Edmund, capped at all other players. Hidden from Percival.' },
  Percival: { team: 'Resistance', description: 'Sees Merlin and Morgana, without knowing which is which.' },
  Tristan: { team: 'Resistance', description: 'Knows Isolde.' },
  Isolde: { team: 'Resistance', description: 'Knows Tristan.' },
  Spy: { team: 'Spy', description: 'Knows spies except Oberon.' },
  Assassin: { team: 'Spy', description: 'Knows spies except Oberon. Can assassinate Merlin or both lovers.' },
  Morgana: { team: 'Spy', description: 'Knows spies except Oberon. Appears as a Merlin candidate to Percival.' },
  Mordred: { team: 'Spy', description: 'Knows spies except Oberon. Hidden from Merlin.' },
  Oberon: { team: 'Spy', description: 'Unknown to other spies; knows none. Visible to Merlin.' },
  Edmund: { team: 'Spy', description: 'Knows the other spies except Oberon. Frames one random Resistance player, making them appear as a spy to Merlin. Knows who was framed.' },
};
export const SPY_COUNTS = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };
export const emptyCounts = () => Object.fromEntries(Object.keys(ROLE_INFO).map(role => [role, 0]));
export function preset(size = 6) {
  const counts = emptyCounts();
  if (size === 15) {
    Object.assign(counts, { Resistance: 5, Merlin: 2, Percival: 3, Assassin: 2, Morgana: 3 });
    return { mode: 'custom', counts };
  }
  const spies = SPY_COUNTS[size];
  Object.assign(counts, { Resistance: size - spies - 2, Merlin: 1, Percival: 1, Assassin: 1, Morgana: 1, Spy: spies - 2 });
  return { mode: 'standard', counts };
}
export function totals(config) {
  const result = { total: 0, Resistance: 0, Spy: 0 };
  for (const [role, count] of Object.entries(config.counts)) {
    result.total += count;
    result[ROLE_INFO[role].team] += count;
  }
  return result;
}
export function validateConfig(config) {
  if (!config || !['standard', 'custom'].includes(config.mode) || !config.counts || typeof config.counts !== 'object' || Array.isArray(config.counts)) return 'Choose a setup mode and role counts.';
  if (Object.keys(config.counts).length !== Object.keys(ROLE_INFO).length || Object.keys(config.counts).some(role => !Object.hasOwn(ROLE_INFO, role))) return 'Use only the supported roles.';
  for (const role of Object.keys(ROLE_INFO)) {
    if (!Number.isInteger(config.counts[role]) || config.counts[role] < 0 || config.counts[role] > 15) return 'Role counts must be whole numbers from 0 to 15.';
  }
  const { total } = totals(config);
  if (total < 1 || total > 15) return 'Choose between 1 and 15 total roles.';
  return null;
}
