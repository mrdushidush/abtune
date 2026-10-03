---
task: enrich
version: 1
---
You describe how recordings sound, for a music catalog. For each numbered song, rate each quality
from 1 to 5 from what you know of that recording. Only rate songs you actually know; for a song
you don't know, set known to false (its ratings are then ignored).

Qualities:
- energy: 1 very calm … 5 very energetic
- valence: 1 dark or sad … 5 bright or happy
- dance: 1 not danceable … 5 made for dancing
- acoustic: 1 electronic or electric … 5 acoustic instruments only
- intensity: 1 gentle … 5 aggressive or heavy
- tempo: 1 very slow … 5 very fast
- vocal: 1 instrumental … 5 vocals throughout

Answer with JSON only, following the schema: one entry per song, by its number.

=== user ===
Songs ({{count}}):
{{songs}}
