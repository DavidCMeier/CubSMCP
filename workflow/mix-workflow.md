# Your mixing workflow

> The agent reads this file before mixing (tool `cubase_get_workflow`, resource `cubase://workflow` and prompt `mix_session`).
> Write YOUR way of working here. The more specific it is, the more the mix will sound like yours.
> Everything in [brackets] is an example to replace.
> A Spanish version is in `mix-workflow.es.md`.

## General rules

- Before each phase, save a snapshot with `cubase_snapshot_mix` (name: `phase-N-description`).
- Never mute, delete or move parts of the song: that is a creative decision. Ask.
- Justify every change with a measurement (meters, stem analysis or comparison with the reference).
- At the end of each phase, summarise what you changed and why.

## Project template

- Cubase template: [Band Mix.cpr]
- Buses already in the template: [DRUMS BUS, BASS BUS, GTR BUS, VOX BUS, FX REVERB PLATE, FX REVERB HALL, FX DELAY 1/4, MIX BUS]
- Chains loaded and bypassed per track type (the agent only switches them on and tunes them):
  - Kick: [insert 1 EQ, insert 2 compressor, insert 3 saturation]
  - Snare: [...]
  - Bass: [...]
  - Guitars: [...]
  - Lead vocal: [insert 1 de-esser, insert 2 compressor 1, insert 3 compressor 2, insert 4 EQ]
  - Mix bus: [insert 1 EQ, insert 2 bus compressor, insert 3 limiter]

## Phase 1 - Organisation

- Track names: [Kick In, Kick Out, Snare Top, Snare Bottom, OH L, OH R, Room, Bass DI, Bass Amp, Gtr L, Gtr R, Lead Vox, BV 1...]
- Routing: each family to its bus (drums -> DRUMS BUS...).
- Colours per family: [drums red, bass orange, guitars green, vocals blue, FX purple] (colouring needs a macro or a Project Logical Editor preset).

## Phase 2 - Cleanup and gain

- Default low cut: [vocals 80 Hz, guitars 90 Hz, overheads 150 Hz, no low cut on kick and bass]
- Gain staging: each track peaking at [-10 dBFS] with the faders at 0 dB (`cubase_gain_stage`).
- Phase: check the polarity of [Snare Bottom] and [Kick In/Out].

## Phase 3 - Static balance

- Level reference: [snare at -10 dB on the bus, vocal above the rest].
- Panning: [OH L/R at 70 %, double-tracked guitars L100/R100, bass, kick, snare and vocal in the centre].

## Phase 4 - EQ and dynamics

- Kick: [punch 60-80 Hz, cut 300-400 Hz, click 3-5 kHz; compressor ratio 4:1, attack 10 ms].
- Bass: [...]
- Guitars: [...]
- Vocal: [serial compression, 3-6 dB of reduction in total; de-esser 6-8 kHz].
- Frequency conflicts: use `audio_analyze_folder` on the stems and resolve them by priority [vocal > snare > kick > bass > guitars].

## Phase 5 - Effects

- Plate reverb for vocal and snare, send between [-18 and -12 dB].
- 1/4 delay on the vocal in the choruses (the agent suggests, you decide).

## Phase 6 - Mix bus and mastering

- Bus compressor: [2:1, attack 30 ms, auto release, 1-2 dB of reduction].
- Loudness target: [-14 LUFS integrated for streaming], true peak at most [-1 dBTP].
- Reference: [absolute path to the reference song].
- Check with `audio_compare_to_reference` and adjust the mix bus EQ if any band is more than 1.5 dB off.

## Deliverables

- Export: [WAV mix 24 bit 48 kHz + master + stems per bus] to [folder path].
- File name: [Artist - Song - Mix vN].
