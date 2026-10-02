# Data licenses

ABTune's **code** is MIT-licensed. The **music catalog** it builds comes from open data, and each source has its own license. This page lists them, says how each was verified, and explains what that means for the catalog files we distribute. HANDOFF §6.9 asks for this; it was last checked on 2026-10-01.

## Sources

| Source | What we use | License | How verified |
|---|---|---|---|
| **MusicBrainz core data**: `mbdump.tar.bz2`, full export 2026-09-30 | recordings, releases, release groups and their secondary types, release dates (via tracks and media), artists and credits, areas, ISRCs, recording→work links, work languages | **CC0 1.0** | The `COPYING` file inside the dump. The build checks it on every run and stops if it changes |
| **MusicBrainz supplementary data**: `mbdump-derived.tar.bz2` | tags and genre votes on recordings, release groups and artists | **CC BY-NC-SA 3.0 US** | The `COPYING` file inside the dump ("Attribution-NonCommercial-ShareAlike 3.0 US"), checked on every build. MusicBrainz's [database page](https://musicbrainz.org/doc/MusicBrainz_Database) lists "tags (including genre associations)" as supplementary data |
| **MusicBrainz canonical data** (ListenBrainz), dump 2026-09-17 | `canonical_recording_redirect.csv`: each recording → its canonical recording and release | **CC0 1.0** | The `COPYING` file inside the dump, checked on every build; also [the docs page](https://musicbrainz.org/doc/Canonical_MusicBrainz_data) |
| **ListenBrainz statistics dump**, 2026-09-15 | `recordings_all_time.jsonl`: each user's all-time top recordings, summed into a popularity proxy. No user ids are kept in the catalog | **CC0 1.0** | The `COPYING` file inside the dump, checked on every build |
| **ListenBrainz popularity API** (`/1/popularity/recording`) | total listeners and listens per recording, for ranking | CC0 | MetaBrainz on its API data, popularity included: "All of this data is Creative Commons CC0 licensed (read Public Domain) and available on our API endpoints, for free, forever." ([blog, 2024-11-28](https://blog.metabrainz.org/2024/11/28/pissed-off-by-spotify-enshittifying-more-api-endpoints-we-can-help/)). The counts include [MLHD+](https://musicbrainz.org/doc/MLHD+); we could not find a license statement for MLHD+ itself. It contributes only aggregate counts, and the catalog is already NC-SA |
| **AcousticBrainz** final dumps, 2022-06-23: high-level JSON and low-level rhythm features | mood, danceability, voice/instrumental and genre classifier probabilities; BPM | **CC0 1.0** | "All of the data contained in AcousticBrainz is licensed under the CC0 license (public domain)." ([MusicBrainz wiki](https://musicbrainz.org/doc/AcousticBrainz)). These dumps contain no `COPYING` file, so the build can't check this one |
| Cover Art Archive (M4, optional) | album covers, hotlinked at display time | per image | Never downloaded or stored |
| Spotify Web API (M5) | delivery only | Spotify Developer Terms | **No Spotify metadata goes into the catalog** (HANDOFF §3.1) |

## What the catalog files are licensed under

Genre clusters, the complexity/intensity nudges and the non-music filter all come from MusicBrainz **tags**, which are supplementary data under CC BY-NC-SA 3.0 US. HANDOFF §6.9 says an artifact takes the license of its most restrictive input, so every catalog file we produce is **CC BY-NC-SA 3.0 US**:

| Artifact | Where | License file |
|---|---|---|
| Full catalog (~2M tracks) | `data/catalog/catalog-YYYY.MM/`, built locally | `LICENSE.md` next to `tracks.parquet` |
| Dev sample (50k tracks) | GitHub release asset `catalog-YYYY.MM-dev50k.tar` | `LICENSE.md` inside the archive |
| Test fixture (5k tracks) | `data/catalog-fixture/`, committed to this repo | [`data/catalog-fixture/LICENSE.md`](../data/catalog-fixture/LICENSE.md) |

Attribution, which ships in every `LICENSE.md` and `manifest.json`:

> Contains data from MusicBrainz (https://musicbrainz.org), ListenBrainz (https://listenbrainz.org) and AcousticBrainz (https://acousticbrainz.org), MetaBrainz Foundation.

What this means in practice:

- **Self-hosting for yourself and friends** (the v1 audience) is non-commercial use: fine with attribution.
- **Redistributing** a catalog, modified or not, must keep CC BY-NC-SA 3.0 US.
- **The code** (everything outside `data/catalog-fixture/` and the catalog artifacts) stays MIT. Anyone can run `abtune catalog build` against the dumps themselves instead of downloading our artifact (§6.9's build-locally path).
- **A commercial hosted version** would need permission for the supplementary data from MetaBrainz, or a catalog built without tags (for example, clusters from the CC0 AcousticBrainz genre classifiers only). This is an open item for the hosted version, not for v1.
