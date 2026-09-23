# Not licensed for use

The JPGs in this folder and the faction PNGs in `../icons/` (including the four
Grand Alliance icons `order.png`/`chaos.png`/`death.png`/`destruction.png`) are
official Games Workshop artwork/iconography with no license for reuse here.

As of 2026-09-23, `index.html`'s `applyFactionBackground()` no longer loads any
of them — Age of Sigmar factions and alliances use a color-only gradient
background instead (see the `c1`/`c2` fields already in `FACTION_BG`).

`assets/factions-40k/*.svg` is unaffected — those are self-made placeholder
crests (radial gradient + initials), not GW art, and are still used for 40k.

Before restoring image backgrounds for AoS: either commission/license your own
faction art, or replace these files with genuinely free-to-use art (your own
photos of your own painted miniatures are the simplest safe option), then
reintroduce the `fb.img`/`fb.icon` lookup in `applyFactionBackground()`.
