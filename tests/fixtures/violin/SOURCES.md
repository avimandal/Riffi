# Violin recordings (test fixtures)

All files here are cut from the **VS Chamber Orchestra: Community Edition (VSCO-2 CE)**
by Versilian Studios — recorded by Sam Gossner & Simon Dalzell, sample cutting by
Elan Hickler/Soundemote.

- Source: https://github.com/sgossner/VSCO-2-CE (folder `Strings/Solo Violin/`), downloaded 2026-10-14
- Licence: **CC0 1.0 Universal** (public domain dedication), see the repository's `LICENSE`

What was done to them: mixed to mono, 16-bit, 44.1 kHz, and trimmed (sustained notes to
the first 1.6–2.5 s, spiccato notes to 0.7 s). Nothing else, except:

| File | From | Note |
| --- | --- | --- |
| `arco_G3_f`, `arco_G3_p`, `arco_A4_f`, `arco_A4_p`, `arco_E5_f`, `arco_E5_p`, `arco_A3_f`, `arco_C4_f`, `arco_E4_f`, `arco_G4_f`, `arco_C5_f` | `Arco Vib/LLVln_ArcoVib_<note>_<f/p>.wav` | Sustained bowed notes with vibrato, loud (`f`) and soft (`p`). |
| `arco_D4_f_from_E4`, `arco_D4_p_from_E4` | `Arco Vib/LLVln_ArcoVib_E4_<f/p>.wav` | **VSCO-2 CE has no D4**, so these are the real E4 recordings played 2 semitones lower (resampled with ffmpeg `asetrate`). Same violin and bowing; slightly darker timbre than a real D4. |
| `spic_<note>` | `spic/LLVln_spic_<note one octave lower>_v2_rr1.wav` | Short bounced (spiccato) notes. VSCO names these one octave below the pitch they sound (it has a "G2", below the violin's range), so they're renamed here to the **sounding** pitch, checked with the pitch engine. |

The tests also pass these through a simulated phone microphone (low-end roll-off, hiss,
room rumble, no auto gain): see `tests/fixtures/violinAudio.ts`. Melodies for the
follower tests are sequenced from these real notes (see `tests/unit/followViolin.test.ts`):
real violin sound, but not a real performance of a whole tune.
