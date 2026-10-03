# AI interpret eval (T1), 2026-10-03

Model `qwen3.6-35b-a3b-mtp@iq3_s`, prompt interpret v1, catalog catalog-2026.09.2 (full), engine 0.4.0+bank.acc7afbe.
36 calls: 36 ok; median 3.3 s, max 4.3 s. 12 personas, modes 10/20/50, 3 playlists each, length 50.

| mode | fit classic | fit AI | canon classic | canon AI | sig classic | sig AI | Hebrew personas classic | AI |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 0.195 | 0.198 | 14.50 | 15.17 | 79.5% | 78.7% | 11.9% | 11.8% |
| 20 | 0.375 | 0.390 | 10.56 | 8.61 | 74.9% | 74.9% | 10.7% | 11.2% |
| 50 | 0.516 | 0.536 | 4.83 | 5.67 | 71.1% | 69.2% | 9.1% | 9.6% |

Overall: canon 9.96 → 9.81, sig 75.2% → 74.3%, Hebrew personas 52.2% → 54.3%.

Per persona (fit, classic → AI) and the AI's title:

| persona | @10 | @20 | @50 | title @50 |
|---|---:|---:|---:|---|
| classical_soundtrack | 0.777 → 0.764 | 0.730 → 0.673 | 0.572 → 0.546 | Epic Orchestral Focus |
| edm_festival | 0.147 → 0.157 | 0.473 → 0.544 | 0.624 → 0.649 | High Energy Festival Drops |
| eighties_pop | 0.162 → 0.175 | 0.336 → 0.379 | 0.458 → 0.494 | Shiny Synth Pop Hits |
| everything_mainstream | 0.383 → 0.378 | 0.550 → 0.538 | 0.762 → 0.750 | Polished Pop Hits |
| hebrew_mizrahi_party | 0.055 → 0.048 | 0.103 → 0.107 | 0.029 → 0.074 | High Energy Hebrew Pop Hits |
| hebrew_rock_pop | 0.303 → 0.261 | 0.390 → 0.436 | 0.818 → 0.819 | Hebrew Rock & Arena Anthems |
| indie_folk_introvert | 0.011 → 0.010 | 0.173 → 0.194 | 0.480 → 0.465 | Quiet Indie Mornings |
| jazz_soul_dinner | 0.391 → 0.443 | 0.371 → 0.372 | 0.644 → 0.773 | Smooth Soul & Jazz Ballads |
| lofi_focus | 0.045 → 0.074 | 0.207 → 0.201 | 0.525 → 0.496 | Smooth Jazz and Modern R&B Vibes |
| metalhead_2000s | 0.016 → 0.014 | 0.449 → 0.531 | 0.235 → 0.306 | Heavy Drops and Rave Riffs |
| modern_hiphop_rnb | 0.019 → 0.021 | 0.191 → 0.145 | 0.549 → 0.534 | Neon Nights and Vocal Hooks |
| workout_high_tempo | 0.034 → 0.029 | 0.525 → 0.559 | 0.497 → 0.531 | Festival Rave and Pop Hits |

**Reading:** a small, consistent fit gain at every depth, with recognition about unchanged (both gates still pass) and Hebrew personas slightly more Hebrew. Per persona the effect is mixed (classical_soundtrack and modern_hiphop_rnb lose a little, jazz_soul_dinner and metalhead_2000s gain most). The adjustment gains stay as designed (DECISIONS.md, AI layer).
