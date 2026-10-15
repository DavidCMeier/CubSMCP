# cubase-mcp

**English** · [Español](README.es.md)

MCP server to control **Cubase 13 on macOS** from Claude (Desktop or Code) and automate the technical side of mixing.

Cubase has no public API, so the connection uses Steinberg's official route: a **MIDI Remote script** (API 1.2) that runs inside Cubase and talks to the MCP server over SysEx through two IAC buses.

```
Claude ──MCP (stdio)──> cubase-mcp (Node) ──SysEx/IAC "MCP to Cubase"──> MIDI Remote script ──> Cubase 13
                              ^                                                   │
                              └──────────── SysEx/IAC "MCP from Cubase" <────────┘
                              │
                              └──> ffmpeg (stem and mix analysis: the "ears")
```

## What it can do

| Area | Tools |
|---|---|
| Diagnostics | `cubase_status`, `cubase_list_midi_ports`, `cubase_get_script_log` (requests can be filtered by number, method and server), `cubase_reload_script`, raw value access (also by channel name: `ch[G L Clean].volume` or `{channel, field}`, on any bank page) |
| Mixer (every channel in the bank) | list channels (with their type: audio, instrument, group, FX, VCA, output...), fader in dB, pan, mute/solo/rec/monitor, automation read and write, phase, input gain, low cut, sends (level, on, pre/post), `cubase_apply_mix` for many changes at once, bank paging (go to a page or to a given channel), channels hidden in the MixConsole (count and `showAll`), routing readout (`cubase_get_routing`: output and send destinations; it cannot be changed), channel renaming through DirectAccess (`cubase_rename_channel`) |
| Snapshots | `cubase_snapshot_mix`, `cubase_list_snapshots`, `cubase_restore_mix`, `cubase_delete_snapshot`: the whole MixConsole (every bank page), including low cut, identifying each channel by its Cubase UID. With a channel soloed, Cubase shows implicit mutes and solos, so the snapshot does not store them; restoring clears the solos before restoring the mutes. It stores each channel's automation read state and does not restore channels that have it on (`writeAutomated` forces it). The Pre section and the sends of MIDI channels (and VCAs) are stored as null. An existing snapshot is not overwritten without `overwrite: true`; the list gives date, channels, `allPages`, version and size; restoring accepts `dryRun` (compare only) and filters by channel (`channels`) and by field (`fields`) |
| Channel strip (selected track) | full Pre section, 4-band EQ in Hz/dB/Q (Q from 0 to 12) and filter type by name ("Parametric II", "High Pass I"...; `listTypes` gives the band's list and every write is checked against the display), strip modules (gate, compressor, tools, saturator, limiter), 16 insert slots (on, bypass, open window; empty ones carry `empty: true`), quick controls and readout of the focused quick controls (`cubase_get_focused_quick_controls`). `cubase_get_channel_strip` can return only some sections (`sections`). `cubase_select_track` moves one track forward, jumps to the first or the last (`to`) or to a track by name (`name`) |
| Plugins (DirectAccess) | list and change **any parameter** of any insert, strip or instrument plugin, in real units (dB, Hz, ms) or normalized, also in batch (`valueInUnits` per item); every write reports whether Cubase applied it (`applied`, `changed`). The list accepts `fields` and `titlesOnly` for short responses, `tag`/`tags` to read single parameters, and title filters with `match` (`contains`, `exact`, `regex`) and `matchedTotal`; a title that matches several parameters returns an error with the list instead of writing the first one. Browse the object tree of the whole MixConsole |
| Transport | play, stop, record, cycle, metronome, move forward and back N seconds, move forward or back one bar, nudge, place the cursor at a time, set the locators (`set_locators`), "Return to Start Position on Stop" (`returnOnStop`), go to markers and locators, list marker positions (`cubase_list_markers`; Cubase does not give their names), Control Room. Every response includes the cursor and the locators (DirectAccess time), and `cubase_go_to_marker` reports whether the marker exists (`markerFound`). The tempo cannot be read: Cubase 13 does not expose it to MIDI Remote |
| Commands | 636 key commands of Cubase 13 (out of its ~1,450; `cubase_list_commands` with `includeUnbound` also lists the rest, marked `inCatalog: false`), plus your macros and Logical Editor presets. A name the script does not map returns an error before anything is sent, with similar commands. Cubase does not confirm commands: the response says `sent` and `confirmed: false`, and with `waitFor` the tool waits for a raw value to reach a state or to change. Start, Stop, StartStop, Record, Cycle and Metronome On are written as transport values and are confirmed |
| Metering | per-channel meters (peak and RMS average over playback time; `cubase_get_meters` filters by channels or by `onlyWithSignal`), `cubase_measure_levels` (plays a section and measures peaks; with `allPages`, one pass per bank page), `cubase_gain_stage` (proposes or applies input gain: it accounts for the fader, leaves out groups, FX, VCAs and outputs by their type, and explains what it excludes). A marker that does not exist returns an error before playback |
| Audio analysis | LUFS, LRA, true peak, RMS, crest factor, stereo width and correlation, tonal balance by band, masking between stems, comparison with a reference |
| Workflow | your workflow in `workflow/mix-workflow.md` (resource, tool and `mix_session` prompt), save project (with `projectFile`, it checks that the file was written), undo (reports what changed on the bank page and, with UI automation enabled, which Edit menu step it undid and which one comes next, `stepAfter`), create buses for the selection (returns the new channel, the index shift and the tracks' previous output), export mix or stems (with `folder`, returns the files written) |
| UI automation (optional) | menus and submenus (list them with shortcuts and check marks, and click), keys (F1-F12 and numeric keypad), type text, read the focused element, Cubase windows. Every action reports which app ended up in front and which windows opened or closed. `cubase_rename_channel` in `field` mode opens the name field for you to type in (by default it renames through DirectAccess, with no UI) |

In total, 71 tools, 3 resources and 1 prompt.

## Cubase 13 limits (important)

- **New plugins cannot be loaded into a slot**. The function exists in API 1.3, which comes with Cubase 15. Workaround: load your chains in the **project template** (deactivated) and let the agent activate and adjust them.
- **Event contents cannot be read** (MIDI notes, audio edits).
- **Track color and order** are not exposed. For color, use macros or Project Logical Editor presets added to `commands/user-commands.txt`.
- **The agent cannot hear.** To make decisions it needs measurements: live meters, or exported stems analyzed with ffmpeg.
- **Meters only exist for the 48 slots of the bank page in view.** Statistics are per slot, not per channel. To measure the whole project, `cubase_measure_levels` and `cubase_gain_stage` accept `allPages: true` and play the section once per page.
- **Cubase does not confirm key commands**, nor does it say whether there was anything to undo, save or export. The tools check what they can (bank values, cursor position, files) and otherwise say so with `confirmed: false` or `verified: false`.
- **The MixConsole history does not record mute or solo.** After a mute, `cubase_undo` undoes the previous step (for example, a fader). A rename through DirectAccess does not enter the edit history either.
- **Writes made by searches may leave no step in the MixConsole history.** In the test on 15 October, the `cubase_set_volume` writes (dB search) did not enter the history, and `cubase_undo` undid an earlier step: another channel's input gain. With `expect` (`{channel, field}`), `cubase_undo` checks that the expected value changed and, if something else changed, redoes it immediately and returns an error. Without `expect`, it warns when what it undid is not the last thing the server wrote. To revert server writes, the safe way is `cubase_snapshot_mix` before and `cubase_restore_mix` after.
- **With automation read on, automation wins.** Cubase replaces automated values as soon as the cursor moves, and does not say which parameters have automation. Snapshots store `autoRead` per channel and count those channels; `cubase_restore_mix` does not write them (except solo) and lists them in `automated`, unless `writeAutomated: true` is passed. `cubase_set_volume`, `cubase_set_pan` and `cubase_apply_mix` warn when the channel has it on.
- **Routing cannot be changed through the API.** The output can be read (DirectAccess, "Output"; `cubase_get_routing` returns it together with the send destinations), but Cubase ignores what is written; send destinations and inputs cannot be set. For the same reason, `cubase_create_bus_for_selection` cannot choose mono or stereo, the output or a plugin for the new bus (it can set the name, with `name`). When you undo a group created with `cubase_create_bus_for_selection`, the source track is left on "No Bus": `cubase_undo` warns about it and returns the output it had so you can set it by hand.
- Values arrive normalized (0..1). To work in dB or Hz, the server runs a binary search against what Cubase displays. It takes about 1 second per value.
- **The mixer bank is a 48-channel window that moves by offset**, not by fixed pages: `next` moves 48 forward without going past the last channel, and the `shift` actions move it one channel at a time. MIDI Remote cannot read or set that offset, so the server infers it from the channel UIDs.
  - A number (or a digits-only string, such as `"12"`) is a **bank index on the page in view now**: it changes if `cubase_bank` moves the bank.
  - Any other string is a **name**: it is searched on every page, case-insensitively (exact, then unique prefix, then unique substring), and the bank then returns to its page. If several channels match, the call fails and lists them; for repeated names use `#N` (`"G L#2"` is the second "G L" in MixConsole order). Searching by name in a multi-page project takes a few seconds, because the bank has to be scanned.
  - An object `{name, occurrence?, exact?}` requires the full name (no prefix or substring, and `#N` is not parsed): `{"name": "G L", "occurrence": 2}` is the second "G L"; `exact: false` allows prefix and substring again. Ambiguity errors list the page, index and UID of each candidate.
  - `cubase_bank` with `goToPage` (page N counted from the first channel) or `showChannel` (the page where a channel is) leaves the bank there; every response gives `atStart`, `atEnd`, `page` and how many channels are hidden.
  - Blank names and numbers that are not integers ≥ 0 are rejected. Claude Code sends an invalid index (37.5, -1) as text, and the server rejects it instead of looking it up as a name.

## Installation

### 1. Requirements

```bash
brew install node ffmpeg
```

Node 20 or later.

### 2. Create the IAC buses

1. Open **Audio MIDI Setup** and go to **Window > Show MIDI Studio**.
2. Open the **IAC Driver**.
3. Check **Device is online**.
4. Add two buses named exactly **`MCP to Cubase`** and **`MCP from Cubase`**.

### 3. Keep the buses out of your tracks

In Cubase, go to **Studio > Studio Setup > MIDI Port Setup** and uncheck **"In 'All MIDI Inputs'"** for both IAC ports.

### 4. Build and install

```bash
git clone https://github.com/DavidCMeier/CubSMCP.git
cd CubSMCP
npm install
npm run build
npm run install:script
```

`install:script` copies the script to `~/Documents/Steinberg/Cubase/MIDI Remote/Driver Scripts/Local/MCP/CubaseBridge/`.

### 5. Enable the surface in Cubase

1. Open Cubase and load a project.
2. Open the **MIDI Remote** tab in the lower zone. **MCP CubaseBridge** should appear.
3. If it does not, click **+ (Add MIDI Controller Surface)** and set:
   - vendor `MCP`
   - model `CubaseBridge`
   - input `MCP to Cubase`
   - output `MCP from Cubase`
4. If you change the script, reload it by hand: in the **MIDI Remote Manager**, menu **Scripting Tools > Reload Scripts**. Cubase 13 ignores a reload requested from the script itself, so `cubase_reload_script` only tries and warns you if it did not work.

### 6. Connect to Claude

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cubase": {
      "command": "node",
      "args": ["/PATH/TO/CubSMCP/dist/index.js"],
      "env": {
        "CUBASE_MCP_ENABLE_UI": "1"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add cubase --env CUBASE_MCP_ENABLE_UI=1 -- node /PATH/TO/CubSMCP/dist/index.js
```

For the `ui_*` tools, give **Accessibility** permission to the app that launches the server (Claude or Terminal) in System Settings > Privacy & Security > Accessibility.

### 7. Permissions in Claude Code (auto mode)

In auto mode, Claude Code uses a classifier to decide whether to run each tool. In the test with Cubase 13 it denied `ui_click_menu` ("Save As...", "Export > Audio Mixdown...") and `ui_key`. After the first denial it also denied reads, such as `ui_front_window`, and nothing could be checked or restored any more. A denied call never reaches the server.

To avoid this, add permission rules to `~/.claude/settings.json` (all projects) or to the project's `.claude/settings.local.json`. With `allow`, the tool runs without going through the classifier. With `ask`, Claude Code asks you, also in auto mode. `ask` wins over `allow`, so it is enough to allow the whole server and ask for confirmation for whatever presses keys or menus, runs commands, saves or exports:

```json
{
  "permissions": {
    "allow": ["mcp__cubase"],
    "ask": [
      "mcp__cubase__ui_click_menu",
      "mcp__cubase__ui_key",
      "mcp__cubase__ui_keystroke",
      "mcp__cubase__ui_type_text",
      "mcp__cubase__cubase_run_command",
      "mcp__cubase__cubase_run_command_sequence",
      "mcp__cubase__cubase_undo",
      "mcp__cubase__cubase_save_project",
      "mcp__cubase__cubase_export_audio_mixdown",
      "mcp__cubase__cubase_create_bus_for_selection",
      "mcp__cubase__cubase_set_raw_value",
      "mcp__cubase__cubase_da_set_parameter"
    ]
  }
}
```

- `cubase` is the name you gave the server (`claude mcp add cubase ...`). If you used another one, change the prefix. The active rules are shown with `/permissions`.
- Reads (`ui_list_menu`, `ui_front_window`, `ui_list_windows`, `ui_read_focused`, `cubase_get_*`...) and mixing (fader, pan, EQ, plugins, snapshots) stay allowed. If you want to confirm anything else, add it to `ask`.
- If Claude Code or you deny a call, the agent must not retry it another way (`osascript`, another `ui_*` tool). The classifier treats that as an attempt to get around the denial and starts denying reads too.

## Environment variables

| Variable | Default | Use |
|---|---|---|
| `CUBASE_MCP_PORT_MODE` | `iac` | `virtual` creates its own CoreMIDI ports instead of using IAC. Cubase has to see them before it starts. |
| `CUBASE_MCP_TO_CUBASE_PORT` | `MCP to Cubase` | Name (or part of it) of the output bus to Cubase |
| `CUBASE_MCP_FROM_CUBASE_PORT` | `MCP from Cubase` | Name (or part of it) of the input bus from Cubase |
| `CUBASE_MCP_TIMEOUT_MS` | `4000` | Maximum wait per request |
| `CUBASE_MCP_STALL_RECOVERY_MS` | `25000` | Total time a read or an absolute write waits for MIDI Remote to come out of a stall: it pings until Cubase answers and resends it (2 times at most). Pulses, actions and commands are never resent: their timeout says the response was lost and that Cubase may have run them. |
| `CUBASE_MCP_SETTLE_MS` | `150` | Pause between writing a value and reading it back. With 60 ms, Cubase 13 freezes for about 10 s in 1 out of 3 searches; with 150 ms it has not frozen in 20 tests. |
| `CUBASE_MCP_APP_NAME` | `Cubase 13` | Process name for UI automation |
| `CUBASE_MCP_ENABLE_UI` | `0` | `1` enables the `ui_*` tools |
| `CUBASE_MCP_WORKFLOW_FILE` | `workflow/mix-workflow.md` | Your mix workflow |
| `CUBASE_MCP_SNAPSHOT_DIR` | `~/.cubase-mcp/snapshots` | Snapshot folder |
| `CUBASE_MCP_FFMPEG` / `CUBASE_MCP_FFPROBE` | `ffmpeg` / `ffprobe` | ffmpeg paths |

In the `CONFIG` section of the script (`cubase-script/template/MCP_CubaseBridge.template.js`) you can set the bank size (48 channels by default), the sends, the insert slots and whether output buses are included. Then run `npm run install:script` and reload the script.

## Selection, plugins and DirectAccess

- **Selecting has side effects.** The EQ, inserts, modules, quick controls and plugins are only exposed on the selected track, so the tools that take `channel` select it (a track that is already selected is not selected again; `cubase_set_prefilter` writes gain, phase and low cut through the bank, without selecting). With the preference "Enable Record on Selected Audio Track" (Preferences > Editing > Project & MixConsole), Cubase also arms the track and creates a 0-byte WAV in `Audio/` each time (File > Cleanup deletes them). Responses include `sideEffects` with the previous selection, `recordEnabled` and `armedBySelection`; `disarm: true` disarms the track and `restoreSelection: true` selects the previous one again when done. `openEditor: true` in `cubase_set_channel_state` also selects, and accepts the same two options; that tool also reports in `sideEffects` that turning on automation write turns on automation read, and the implicit states of a solo.
- **Empty slots and plugins that are not installed.** Cubase leaves an object in the slot with its own controls. Reading or writing parameters of an empty slot, of a plugin that is not installed or of the instrument of an audio track returns an error; `cubase_list_inserts` and `cubase_get_channel_strip` mark `missing: true` and do not show the vendor of those plugins, because Cubase reports its own.
- **Text that Cubase does not understand.** With `display`, Cubase silently ignores text it does not understand. The tools compare before and after: ignored text returns an error, and text that moves the parameter to a different value returns `applied: false` with a warning.
- **Quick controls.** One with no assigned parameter is not written (`assigned: false`): Cubase discards the write and, on focused ones, returns the previous write. The API cannot assign them.
- **DirectAccess.** A nonexistent `objectId` or tag returns an error. The `controlroom` scope returns an error when Control Room is disabled (Cubase points it at the mixer root). `mixerChannelIndex` is DirectAccess numbering (Stereo Out is -1), not the bank index: `cubase_da_tree` adds `bankIndex` when the channel is in the bank. `cubase_da_find` searches breadth-first with a node budget (`maxNodes`, 20,000 by default) and warns with `truncated`.

## UI automation

The `ui_*` tools need `CUBASE_MCP_ENABLE_UI=1` and the Accessibility permission. Things worth knowing:

- **Menu names follow Cubase's display language.** In English: `["File","Export","Audio Mixdown..."]`. Stop is in a submenu, `["Transport","Transport Commands","Stop"]` in English (check the exact path with `ui_list_menu`). Some labels change with the project (Undo carries the name of the last action) or end in "…" (U+2026), such as Preferences, which is "Settings…" in some languages. In Spanish, for example, the paths are `["Archivo","Exportar","Mezcla de audio..."]` and `["Transporte","Comandos de transporte","Detener"]`, Undo reads "Deshacer Ajustar nombre de pista" and Preferences is "Ajustes…". To stop, undo or run commands, prefer `cubase_transport`, `cubase_undo` or `cubase_run_command`, which do not depend on the language.
- **`ui_list_menu`** without `menu` lists the menu bar. With `menu` and `submenu` it walks down the submenus and marks disabled items, items that open another menu and checked items (`checked`). Every item with a shortcut includes `shortcut`: the text the menu shows (`"⇧⌘Z"`), `modifiers` and `key`, ready for `ui_keystroke` (one character) or `ui_key` (a name such as `f9` or `pad0`). Only menu item shortcuts are listed, not Cubase key commands that are not in a menu. `ui_click_menu` matches ignoring case, accents and "..."/"…", but never by prefix. If a name does not exist, the error lists the ones that do.
- **Actions report what happened.** `ui_click_menu`, `ui_key`, `ui_keystroke` and `ui_type_text` bring Cubase to the front, send nothing if it does not stay in front, and return the app that ended up in front (`frontApp`, `cubaseFrontmost`), the front window and the windows that opened or closed (`opened`, `closed`). F1 opens the help in the browser, which stays in front. Items that open a window toggle it: a second click on "Studio > Audio Connections..." closes it.
- **Shortcuts run whatever Cubase has assigned to them.** Cmd+Shift+Z is Redo: before trying a shortcut, check the Edit menu with `ui_list_menu`. An uppercase letter is sent with Shift. `ui_key` accepts F1-F12 and the numeric keypad (`pad0`..`pad9`, `pad.`, `pad+`, `pad-`, `pad*`, `pad/`, `padenter`, `padequals`, `padclear`); in Cubase's default key commands the numeric keypad controls the transport (`pad0` is Stop).
- **`ui_read_focused`** reads, without pressing anything or activating Cubase (unless `activate: true`), the focused window and element: role, title, description and value (`AXValue`). Use it to check that a text field has focus before `ui_type_text`, and to read what was typed. Cubase 13 does not expose its own name fields to Accessibility (the track name in the Project window is one of them): there the element shows no value or does not show at all, and the name is checked with `cubase_get_channel`.
- **Windows.** `ui_front_window` and `ui_list_windows` do not activate Cubase. With Cubase in the background, macOS hides plugin editors, so they do not appear until Cubase is activated (`ui_list_windows` with `activate: true`). To find out whether an editor is open, use `editorOpen` from `cubase_get_channel_strip`. Many Cubase windows have no title.
- **Errors.** The message says whether the Accessibility or Automation permission is missing, whether `CUBASE_MCP_APP_NAME` does not match the Cubase process or whether the menu does not exist, and ends with the macOS text.

More details in [docs/installation.md](docs/installation.md).

## First test with Cubase (checklist)

The code is tested against a **simulation** of the MIDI Remote API (`npm test`) and was tested option by option with a real Cubase Pro 13.0.55 (in Spanish) in October 2026. On a new installation, run these checks in order:

1. `cubase_status`: it has to respond and show `directAccess: true` and `insertSlotAccess: true`.
2. `cubase_list_channels`: track names and fader values in dB.
3. `cubase_set_volume` on a test track to -6 dB, then `cubase_undo`: it has to say which channel changed.
4. `cubase_set_channel_state` with mute: check that the mute stays set and does not toggle.
5. `cubase_focus_channel` and then `cubase_get_channel_strip`: EQ, inserts and plugin names.
6. `cubase_get_plugin_parameters` on an insert.
7. `cubase_get_transport_state`: it has to include `position` with the cursor and the locators.
8. `cubase_measure_levels` with 10 seconds.

If something fails, the script log is in `cubase_get_script_log` and in the MIDI Remote console (*Scripting Tools: Open Console*). After updating the server, run `npm run install:script` and reload the script by hand: the script's new functions (channel types, outputs, meter averages) are not available until Cubase reloads it.

If Cubase is slow to load the script, reduce `bankSize` in the `CONFIG` section. The script creates about 2,900 bindings with 48 channels (636 of them are key commands).

## Adding your macros and presets

1. Create a macro or a Project Logical Editor preset in Cubase.
2. Add it to `commands/user-commands.txt` with the exact category and name from *Edit > Key Commands*:

   ```
   [Macro]
   MCP Prepare Mix Session
   ```

3. Run `npm run install:script` and reload the scripts.

## Development

```bash
npm test   # builds, checks that the script is ES5 and runs the tests with the simulation and ffmpeg
```

Structure:

- `cubase-script/template/`: MIDI Remote script (ES5). The command catalog is injected at build time.
- `commands/`: Cubase 13 command catalog and user commands.
- `src/bridge/`: SysEx protocol and MIDI transport.
- `src/cubase/`: high-level client (search in real units, channel selection).
- `src/tools/`: MCP tools by area.
- `src/analysis/`: audio analysis with ffmpeg.
- `src/ui/`: UI automation on macOS.
- `test/`: MIDI Remote API simulation and tests.

## License

Copyright (C) 2026 DavidCMeier

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version (`GPL-3.0-or-later`). The full text is in [LICENSE](LICENSE).

This program is distributed in the hope that it will be useful, but **WITHOUT ANY WARRANTY**; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

In short: you can use it, change it and share it, also for paid work. If you distribute a modified version, it has to carry the same license and its source code.

Cubase and Steinberg are trademarks of Steinberg Media Technologies GmbH. This project is not affiliated with Steinberg.
