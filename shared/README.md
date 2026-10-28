# Shared role rules

This folder is the common rules API for the website and Discord bot. This change
adds **Edmund**, an optional evil (`Spy`) role. Role logic and role tests live in `shared/`. Discord storage migrations preserve
existing setups, and both deployment test commands include the shared tests.
Commands and game phases are unchanged.

## Edmund

At role assignment, each Edmund randomly frames one player whose actual team is
Resistance, with no restriction on their role. Eligible roles are Resistance,
Merlin, Fool, Percival, Tristan, and Isolde. Each good player has an equal chance
of being selected. The Edmund cannot frame itself or any other evil player.
If no good player exists in a custom setup, its target is
`null` and no player is framed.

Each Edmund chooses independently, so multiple Edmunds may frame the same person.
Every real Merlin sees the union of normally visible spies and framed players,
without duplicates and in public seat order. A framed Merlin sees themself in
that list, and other Merlins also see them as evil. The framed player remains on
the Resistance team and retains their actual role and knowledge. There is no
separate notification to the target; a framed Merlin can infer the frame from
their own appearance in the list. Mordred stays hidden. Edmund itself is visible to Merlin and to other
spies under the normal teammate rules; Oberon remains hidden from its teammates.

An Edmund sees its real spy teammates in `information.players`. Its own framed
player is identified by public seat number and player ID in
`information.explanation`, which the existing website and role DM already display.
The same identity is also returned as `information.framedPlayer: { id, name }`
(`null` if there is no target) for future client use. This field is returned only
to that Edmund. The framed player is deliberately excluded from its teammate list
so the existing clients do not label a known good player as a spy teammate. On the
website the explanation is under **Role details** inside the private role panel.

Other spies, Percival, and lovers get no extra information about frames. Merlin's
reveal does not distinguish actual spies from framed players, and reveals no exact
roles. Target IDs must stay in private server state, never in the public roster.

## Fool with Edmunds

Each Fool's fixed random suspect count is:

```text
min(total Spy count + Edmund count, total players - 1)
```

The total Spy count already includes Edmunds, Mordred, and Oberon. Each Edmund
adds one more suspect. For example, two Edmunds and one other spy give each Fool
five suspects, provided five other players exist. The list excludes the Fool
itself and contains no duplicates. Suspects may be either team, including a real
Merlin; they are chosen independently of Edmund targets. A Fool may itself be an
Edmund's target, but still never appears in its own suspect list.

The extra suspects are present even if an Edmund has no eligible target or multiple
Edmunds choose the same target. All Fools still perceive their role as Merlin,
receive the same explanation as real Merlin, and remain invisible to Percival.

## Implementation and lifecycle

- `roles.js` adds Edmund metadata. `emptyCounts()` and all presets include it at
  zero; existing preset compositions and Spy counts are unchanged. To enable it,
  set `config.counts.Edmund` in a custom role mix.
- `assignRoles()` still shuffles assignments and finalizes private knowledge before
  returning. There is no player choice or additional game phase.
- `assignEdmundKnowledge(players)` stores `edmundTargetId` only on Edmunds, removes
  old target fields from other roles, and draws targets after roles are final.
- The existing `assignFoolKnowledge(players)` entry point now also calls
  `assignEdmundKnowledge()`. This preserves compatibility with the website demo,
  which calls it after swapping roles. It draws a new deal's private information;
  never call it on reads, reconnects, or DM retries. A redeal clears old frame and
  Fool data, including when a seat keeps the same role.
- `startingInformation()` only reads saved IDs. A missing or invalid saved Edmund
  target raises an error rather than silently rerolling or revealing an incomplete
  Merlin list. A saved `null` target explicitly represents no eligible player.
- The existing Discord store already persists full player objects before any DMs.
  The new target IDs and Fool lists therefore survive delivery failures, restarts,
  and retries without changing the delivery flow. The web server retains them
  through reconnects; its existing in-memory games still clear on server restart.
- Previously started games without Edmunds retain their assignments and saved Fool
  lists. On load, saved Discord setups gain a zero count for any newly introduced
  role, including Edmund. Existing counts, creation times, assignments, and DM
  delivery progress are preserved; no preset reset or lobby recreation is needed.

## Validation

Use Node.js 22.12+ and install the existing locked bot dependencies:

```sh
npm --prefix discord-bot ci
npm test
```

The root test command includes `shared/*.test.js`, as does `npm --prefix web test`.
Both bot and website deployments therefore run the Edmund regression tests.
The shared tests cover
eligible and ineligible targets, Merlin seeing themself when framed, multiple Edmunds and Merlins, no-target setups,
Fool counts and self exclusion, role privacy, stable reads, redeals, the demo's
post-swap hook, actual Discord game delivery with a temporary state file and fake
DMs, and the unchanged web API's privacy, reconnect, and reset behavior. The web
test opens a temporary localhost port. No real Discord messages are sent.

The bot tests also cover opening, editing, and starting a saved pre-Edmund lobby,
and preserving assignments and delivery state for games already started.

### Discord setup editor

The current upstream editor displays eight roles per page, with a **Role: count**
heading above each pair of **−** and **+** buttons. Edmund appears on the second
page of the twelve-role catalog. Use
**Next** and **Previous** to navigate, and **Save setup** to apply edits from all
pages. Every page stays within Discord's 40-component limit, including validation
errors. The upstream tests cover page limits, all role labels, navigation, draft
preservation, and saving across pages. No additional setup UI changes are needed for
Edmund; the website also generates its setup inputs from the shared role catalog.
