# Installing the Cubase MCP from scratch

**English** · [Español](instalacion-desde-cero.md)

This guide starts from a Mac with nothing installed and ends with Claude controlling Cubase 13. It was tested with Cubase Pro 13.0.55 in Spanish.

Allow about 20 minutes.

On an Intel Mac, read [Intel Macs](#intel-macs) first: installing with Homebrew is not a good idea there.

## 0. What you are going to set up

```
Claude ──> cubase-mcp server (Node) ──IAC bus "MCP to Cubase"──> MIDI Remote script ──> Cubase 13
                    ^                                                       │
                    └────────────── IAC bus "MCP from Cubase" <─────────────┘
```

Cubase has no public API. The server talks to a MIDI Remote script that runs inside Cubase, through two virtual system MIDI buses (IAC).

## 1. System tools

1. Install Homebrew if you don't have it (https://brew.sh).
2. Install Node, ffmpeg and git:

   ```bash
   brew install node ffmpeg git
   ```

3. Check that Node is version 20 or later:

   ```bash
   node -v
   ```

ffmpeg is what lets Claude "hear": it measures loudness, peaks and frequency balance in audio files.

### Intel Macs

Homebrew 7 no longer publishes new precompiled packages for Intel Macs, so `brew install ffmpeg` can spend a long time compiling. On Intel:

- **Node:** use the official installer (**macOS Installer (.pkg)**, LTS version) from https://nodejs.org/en/download. It installs to `/usr/local/bin/node`.
- **ffmpeg and ffprobe:** use the static Intel binaries from https://evermeet.cx/ffmpeg/, the site that ffmpeg.org links to for Intel macOS. Download the `.zip` files of the released version, unzip them and copy them:

  ```bash
  sudo mkdir -p /usr/local/bin
  sudo mv ffmpeg ffprobe /usr/local/bin/
  sudo xattr -dr com.apple.quarantine /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
  ```

  The `xattr` command removes the "downloaded from the internet" flag. Without it, macOS blocks the binaries, because they are not signed.
- **git:** it comes with the command line tools (`xcode-select --install`). You can also download the repository from GitHub with **Code > Download ZIP**.
- The MIDI library ships a binary for Intel: you don't need Xcode.
- In the Claude configuration in step 6, use `/usr/local/bin/node` and set the ffmpeg paths with `CUBASE_MCP_FFMPEG` and `CUBASE_MCP_FFPROBE`.

## 2. Download and build the server

```bash
mkdir -p ~/repos && cd ~/repos
git clone https://github.com/DavidCMeier/CubSMCP.git
cd CubSMCP
npm install
npm run build
npm test
```

`npm test` must end with `fail 0`.

With npm 11 you may see the warning `npm warn install-scripts` about `@julusian/midi`. You can ignore it: that script only checks the MIDI library's precompiled binary, which already comes in the package.

## 3. Create the two MIDI buses (IAC)

1. Open **Audio MIDI Setup**, in Applications > Utilities.
2. Go to **Window > Show MIDI Studio**.
3. Double-click **IAC Driver**.
4. Check **Device is online**.
5. Under **Ports**, add two buses with the **+** button and give them exactly these names:
   - `MCP to Cubase`
   - `MCP from Cubase`
6. Click **Apply**.

## 4. Install the script into Cubase

```bash
cd ~/repos/CubSMCP
npm run install:script
```

This copies the script to `~/Documents/Steinberg/Cubase/MIDI Remote/Driver Scripts/Local/MCP/CubaseBridge/`.

## 5. Configure Cubase

1. Open Cubase **after** creating the IAC buses, and load any project.
2. Go to **Studio > Studio Setup > MIDI Port Setup**. For both `MCP ...` ports, uncheck **"In 'All MIDI Inputs'"**. If you don't, the MCP messages reach your MIDI tracks.
3. Open the **MIDI Remote** tab in the lower zone of the project window. **MCP CubaseBridge** should appear.
4. If it doesn't, click **+** (add surface) and choose:
   - vendor `MCP`
   - model `CubaseBridge`
   - input `MCP to Cubase`
   - output `MCP from Cubase`
5. Recommended: enable the **Control Room** in Studio > Audio Connections if you want Claude to control the listening level.

**Every time you update the script** with `npm run install:script`, reload it by hand. In the **MIDI Remote Manager**, open the **Scripting Tools** menu and choose **Reload Scripts**. The `cubase_reload_script` tool cannot reload it.

## 6. Connect the server to Claude

### Claude Code (terminal, or the Code tab in the app)

```bash
claude mcp add cubase --scope user --env CUBASE_MCP_ENABLE_UI=1 --env CUBASE_MCP_TIMEOUT_MS=8000 -- node ~/repos/CubSMCP/dist/index.js
claude mcp get cubase
```

It must show `Status: ✔ Connected`.

`CUBASE_MCP_TIMEOUT_MS=8000` raises the timeout from 4 to 8 seconds. With large projects, 4 seconds is too short: a 137-channel project had many timeouts with the default value.

### Claude Desktop (chat)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cubase": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/YOUR_USER/repos/CubSMCP/dist/index.js"],
      "env": {
        "CUBASE_MCP_ENABLE_UI": "1",
        "CUBASE_MCP_TIMEOUT_MS": "8000"
      }
    }
  }
}
```

Use absolute paths and restart Claude Desktop. In `command`, put the path that `which node` returns: `/opt/homebrew/bin/node` with Homebrew on Apple Silicon, `/usr/local/bin/node` with the official installer or on Intel. The app doesn't see the Terminal PATH, so if ffmpeg is not in `/usr/bin`, also add `"CUBASE_MCP_FFMPEG"` and `"CUBASE_MCP_FFPROBE"` with their absolute paths (`which ffmpeg ffprobe`).

**After every `npm run build`** you must restart the server so it loads the new code. In Claude Code, opening a new session is enough. In Claude Desktop, restart the app.

### Claude Code permissions

In auto mode, Claude Code passes every call through a classifier that decides whether it runs. In the October 14 test it denied `ui_click_menu` with "Save As...", "Key Commands..." and "Export > Audio Mixdown...", and also `ui_key 'f9'`. Esc and "Activate Metronome" did go through. After the first denial it also denied reads (`cubase_get_raw_values`, `ui_front_window`), so nothing could be checked or restored. The denied call never reaches the server: it is not an MCP failure.

The fix is to give it permission rules. Add this block to `~/.claude/settings.json` for all projects, or to `.claude/settings.local.json` inside the folder where you open Claude Code:

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

How it works:

- `allow` with `mcp__cubase` allows every tool of the server without going through the classifier: reads, mixing, snapshots and analysis.
- `ask` asks you before running, in auto mode too. Claude Code checks `deny`, then `ask`, then `allow`, so anything in `ask` is asked even though the whole server is in `allow`.
- The `ask` list is whatever presses keys or menus, runs Cubase commands, undoes, saves, exports, creates buses or writes raw values. You can add more; for example, `mcp__cubase__cubase_transport` if you don't want it to record without asking you.
- `cubase` is the name you gave the server in `claude mcp add`. Check it, and see the active rules, with `/permissions`.
- The UI reads (`ui_list_menu`, `ui_front_window`, `ui_list_windows`, `ui_read_focused`) stay allowed on purpose: they are the ones used to check and restore after an action.

If a call is still denied, don't repeat it another way (a manual `osascript` or another `ui_*` tool). The classifier takes that as an attempt to get around the denial and starts denying reads too. Do the action yourself in Cubase, or approve it when Claude Code asks you.

## 7. macOS permissions (for the UI tools)

The `ui_*` tools press keys and menus in Cubase. To use them:

1. Open **System Settings > Privacy & Security > Accessibility**.
2. Turn on the app that launches the server: **Claude** if you use the app, or **Terminal** / **iTerm** if you run `claude` in a terminal.
3. Restart that app.

If macOS also asks for **Automation** permission ("wants to control System Events"), accept it. If you denied it, it is under **Privacy & Security > Automation**.

When something fails, the error from the `ui_*` tools says what to check, based on the macOS error code:

| Message | What to check |
|---|---|
| `macOS denied UI control` | The Accessibility permission from this step. |
| `macOS denied sending Apple events` | The Automation permission. |
| `Cubase process "..." not found` | That Cubase is open and that `CUBASE_MCP_APP_NAME` is its process name (`Cubase 13` by default; you can see it in Activity Monitor). |
| `Menu "..." has no item "..."` | The menu name. The error includes the list of available items. |
| `... is not the frontmost app` | Another app came to the front. Nothing was sent. |

The end of the message carries the original macOS text, in the system language.

### Menu names follow Cubase's language

Menu names are in Cubase's display language. With Cubase in English it is `["File","Export","Audio Mixdown..."]`; with Cubase in another language the names change. In Spanish, for example, it is `["Archivo","Exportar","Mezcla de audio..."]`. Other things seen in the test:

- **Stop** is not directly in the Transport menu but in a submenu. In English this should be `["Transport","Transport Commands","Stop"]`; in Spanish it is `["Transporte","Comandos de transporte","Detener"]`.
- **Undo** carries the last action after it ("Undo Set Track Name" in English, "Deshacer Ajustar nombre de pista" in Spanish), so there is no fixed path. Use `cubase_undo`.
- **Preferences** may be labelled "Settings…", with the "…" character (U+2026); in Spanish it is "Ajustes…". `ui_click_menu` accepts the name with three dots ("Settings...", "Ajustes...").
- **Paste** appears twice in the Edit menu, and macOS adds its own items, such as "Writing Tools".

To discover the names, use `ui_list_menu`: without `menu` it lists the menu bar, with `menu: "Transport"` it lists that menu, and with `submenu: ["Transport Commands"]` it goes down one level. It marks disabled items, items that open a submenu and checked items (`checked`), and gives each item's shortcut (`shortcut`, e.g. `"⇧⌘Z"`, with `modifiers` and `key`). `ui_click_menu` compares ignoring case and accents and treats "..." and "…" as equal, but never matches by prefix, and doesn't click disabled items.

When there is a tool that doesn't depend on the language, it is better: `cubase_transport` to stop or play, `cubase_undo` to undo and `cubase_run_command` for key commands.

### Keys and windows

- `ui_key`, `ui_keystroke`, `ui_type_text` and `ui_click_menu` bring Cubase to the front and check that it is still in front right before sending. Afterwards they return the app left in front (`frontApp`, `cubaseFrontmost`), the front Cubase window and the windows that opened or closed (`opened`, `closed`). If only an untitled window changes, they say so in `notes`, because there is no way to tell which one it is.
- F1 opens the online help in the browser, which stays in front. F4 opens "Audio Connections". `ui_key` accepts f1 to f12 and the numeric keypad keys (`pad0`..`pad9`, `pad.`, `pad+`, `pad-`, `pad*`, `pad/`, `padenter`, `padequals`, `padclear`), which control the transport in Cubase's default key commands (`pad0` is Stop).
- Items that open a window toggle it. The first `ui_click_menu ["Studio","Audio Connections..."]` brings it to the front and the second closes it: check `opened` and `closed`.
- A shortcut runs whatever Cubase has assigned to it, just as if you pressed it. Cmd+Shift+Z is Redo: with a redo pending, a "harmless shortcut" can redo a project action. Before trying shortcuts, look at the Edit menu with `ui_list_menu`, which gives each item's shortcut. An uppercase letter is sent with Shift.
- `ui_front_window` and `ui_list_windows` don't activate Cubase. Many Cubase windows have no title, so `ui_front_window` also gives the first window that has a title.
- `ui_read_focused` reads the focused window and element (role, title, description and value) without pressing anything or activating Cubase. Before `ui_type_text` it tells you whether a text field has focus, and afterwards it lets you read what was typed. Cubase 13 doesn't expose its own name fields to Accessibility (the track name in the project window is one of them): there the element shows up with no value or doesn't show up, and a track's name is checked with `cubase_get_channel`.
- With Cubase in the background, macOS hides plugin editors: after `cubase_set_insert` or `cubase_set_strip_module` with `openEditor: true`, the editor doesn't appear in the window list until Cubase comes to the front (`ui_list_windows` with `activate: true`). The Channel Settings window does appear. To know whether an editor is open, the reliable source is `editorOpen` in `cubase_get_channel_strip`. When a window closes, another very small untitled window may remain for a moment (67×19 in the test); it belongs to Cubase and goes away on its own.

## 8. Set up the export (for reliable measurement)

The bridge's live meters are fine for gain staging, but they sample Cubase's meter and can read up to ~1 dB low on short transients. For exact measurements (peaks, LUFS, tonal balance), Claude exports stems and analyses them with ffmpeg. Set it up once:

1. Go to **File > Export > Audio Mixdown...**.
2. Enable **Channel Batch Export** and select the channels you want to analyse.
3. Choose WAV, 24 bit and the project sample rate. Set the folder to, for example, `~/Music/cubase-mcp-stems/<project>`.
4. Uncheck the options that import into the project.
5. Export once by hand so Cubase saves the settings. After that, `cubase_export_audio_mixdown` repeats the export with the same settings. Pass it the folder in `folder` so it waits for the files and reports which ones it wrote: Cubase doesn't confirm the export. In the same way, `cubase_save_project` with `projectFile` (the path of the `.cpr`) checks that the project was saved.

## 9. Template with your plugin chains

Cubase 13 doesn't allow loading new plugins through the API. Claude can only enable, disable and adjust the ones already in the project. So:

- Create a template with your chains per track type (kick, snare, bass, guitars, vocals, mix bus), loaded and disabled.
- Check that **every plugin in the project is installed on this Mac**. If one is missing, Cubase leaves the slot empty, the chain sounds different and the measurements are useless. You can see it in Studio > VST Plug-in Manager.

## 10. Final check

Ask Claude, in this order:

1. `cubase_status`: it must show `directAccess: true` and `insertSlotAccess: true`.
2. `cubase_list_channels` with `includeValues: false`: your track names must appear.
3. `cubase_set_volume` to -6 dB on a test track, then `cubase_undo`.
4. `cubase_set_pan` to -30 on the test track, then back to 0.
5. `cubase_focus_channel` on a track with an active plugin, then `cubase_get_plugin_parameters`: the plugin's parameters must appear, not the slot controls ("Activ.", "Bypass" or "Edición" in Spanish Cubase).
6. `audio_analyze_file` on any WAV.
7. `ui_list_menu` with no arguments (the menu bar) and with `menu: "File"` (`"Archivo"` in Spanish).

## Common problems

| Symptom | Cause and fix |
|---|---|
| `Cubase did not answer ... within 4000 ms` | Cubase is busy or the project is large. Raise `CUBASE_MCP_TIMEOUT_MS` to 8000. Reads and absolute writes already wait for MIDI Remote to recover from the stall and are resent automatically. If the error says "sent once and not resent", it is a pulse, an action or a command: check whether it ran before repeating it, because it often did. |
| `cubase_status` never answers | The MCP CubaseBridge surface is not active in the MIDI Remote tab, or the IAC buses don't exist or have a different name. Check with `cubase_list_midi_ports`. |
| `osascript is not allowed to send keystrokes` | The Accessibility permission from step 7 is missing. |
| Claude Code denies `ui_click_menu`, `ui_key` or reads in auto mode | The permission rules from "Claude Code permissions" (step 6) are missing. Don't repeat the call another way. |
| `Error opening input ... Invalid data` during analysis | There is an empty or broken WAV in the folder. The analysis skips such files and lists them. |
| Drums or guitars are silent | Plugins are missing (Superior Drummer, amp simulators...). Install or replace them before mixing. |
| The `cubase_list_channels` response is huge | It shouldn't be any more: it returns compact values and only the sends that have a destination. Ask for fewer fields with `fields`, page with `offset`/`limit`, use `includeValues: false` or query one channel at a time with `cubase_get_channel`. |
| Selecting a track arms recording and 0-byte WAVs appear in `Audio/` | It is a Cubase preference: Preferences > Editing > Project & MixConsole > "Enable Record on Selected Audio Track". Each time it arms a track, Cubase creates the take file. Turn it off for mixing and delete those files with File > Cleanup. The tools that select report it in `sideEffects` (`armedBySelection`) and accept `disarm: true` and `restoreSelection: true`; the server doesn't delete files. |

Known limitations are in the [README](../README.md#cubase-13-limits-important).
