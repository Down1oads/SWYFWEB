# Rainbit Kenney art

Generic, brand-free 2D art selected from **Kenney Game Assets All-in-1 3.7.0** for the Rainbit games. All selected source packs are released under Creative Commons Zero (CC0 1.0); attribution is optional, but appreciated.

Runtime root: `gambling/art/kenney/`

## Fast game mapping

| Game | Recommended assets |
| --- | --- |
| Crash | `crash/rocket-red.png`, `effects/soft-flare.png`, `effects/spark-burst.png`, `icons/fire.png` |
| Tower | `icons/structure-tower.png`, `rewards/gem-*.png`, `effects/star-burst.png` |
| Dice | `dice/die-red-1.png` through `dice/die-red-6.png`, `icons/dice.png` |
| Mines | `icons/skull.png`, `icons/exploding.png`, `icons/shield.png`, `rewards/gem-*.png` |
| Wheel / Roulette | `icons/spinner.png`, `icons/arrow-clockwise.png`, `chips/chip-*.png` |
| Coinflip | `icons/flip-head.png`, `icons/flip-tails.png`, `rewards/coin-gold.png`, `rewards/coin-silver.png` |
| Keno | `icons/dollar.png`, `icons/token.png`, `icons/tokens-stack.png` |
| Blackjack / Baccarat / Poker | `cards/card-{suit}-{rank}.png`, `cards/card-back-blue.png`, `icons/cards-fan.png` |
| Slots | `rewards/gem-*.png`, `rewards/coin-*.png`, `icons/crown-a.png`, `icons/award.png`, `icons/suit-*.png` |
| Plinko | `rewards/plinko-ball-blue.png`, `rewards/plinko-ball-silver.png`, `effects/star-burst.png` |

The board-game icons are white 128 px transparent PNGs intended for a dark UI. They can be tinted with CSS `filter`, opacity, or a colored backing tile.

## Exact source mapping

All source paths below are relative to `Kenney Game Assets All-in-1 3.7.0/`.

- `2D assets/Space Shooter Extension/PNG/Sprites X2/Rockets/spaceRockets_004.png` -> `crash/rocket-red.png`
- `Icons/Board Game Icons/PNG/Double (128px)/<name>.png` -> `icons/<name-with-hyphens>.png` for: `arrow_clockwise`, `arrow_counterclockwise`, `award`, `card_flip`, `card_target`, `cards_fan`, `crown_a`, `dice`, `dollar`, `exploding`, `fire`, `flip_head`, `flip_tails`, `hourglass`, `puzzle`, `shield`, `skull`, `spinner`, `structure_tower`, `tag_infinite`, `timer_100`, `token`, `tokens_stack`, `suit_clubs`, `suit_diamonds`, `suit_hearts`, and `suit_spades`.
- `2D assets/Boardgame Pack/PNG/Dice/dieRed_border<N>.png` -> `dice/die-red-<N>.png` for faces 1-6.
- `2D assets/Boardgame Pack/PNG/Chips/chip<Color>White.png` -> `chips/chip-<color>.png` for black, blue, green, and red.
- `2D assets/Boardgame Pack/PNG/Cards/card<Suit><Rank>.png` -> `cards/card-<suit>-<rank>.png` for all 52 standard cards.
- `2D assets/Boardgame Pack/PNG/Cards/cardBack_blue4.png` -> `cards/card-back-blue.png`
- `2D assets/Boardgame Pack/PNG/Cards/cardBack_red4.png` -> `cards/card-back-red.png`
- `2D assets/Boardgame Pack/PNG/Cards/cardJoker.png` -> `cards/card-joker.png`
- `2D assets/Puzzle Pack 1/PNG/Double/element_<color>_diamond_glossy.png` -> `rewards/gem-<color>.png` for blue, green, purple, red, and yellow.
- `2D assets/Puzzle Pack 1/PNG/Double/ballBlue.png` -> `rewards/plinko-ball-blue.png`
- `2D assets/Puzzle Pack 1/PNG/Double/ballGrey.png` -> `rewards/plinko-ball-silver.png`
- `2D assets/Physics Assets/PNG/Other/coin<Kind>.png` -> `rewards/coin-<kind>.png` for bronze, diamond, gold, and silver.
- `2D assets/Particle Pack/PNG (Transparent)/spark_04.png` -> `effects/spark-burst.png`
- `2D assets/Particle Pack/PNG (Transparent)/flare_01.png` -> `effects/soft-flare.png`
- `2D assets/Particle Pack/PNG (Transparent)/star_05.png` -> `effects/star-burst.png`

See `license-cc0.txt` for the license notice.
