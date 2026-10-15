/**
 * A small simulation of Cubase's MIDI Remote API (API 1.2 surface) used to run the generated
 * bridge script inside Node. It is not Cubase: it only mimics the objects and callbacks the
 * script uses, so protocol, bindings and handlers can be tested end to end.
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SELECTED_FLAG_PATH = 'host.mTrackSelection.mMixerChannel.mValue.mSelected';

export const TRACKS = ['Kick', 'Snare', 'Bass DI', 'Guitarra ñ', 'Lead Vox', 'Stereo Out'];

/** Kind, message id and chunk of a SysEx frame (F0 7D 4D version kind idHi idLo chunkHi chunkLo countHi countLo ... F7). */
function frameHeader(bytes) {
  return { kind: bytes[4], id: (bytes[5] << 7) | bytes[6], chunk: (bytes[7] << 7) | bytes[8], count: (bytes[9] << 7) | bytes[10] };
}

/** Bank slot paths: host.mMixConsole.channel<slot>.<rest>. */
const SLOT_PATH = /^host\.mMixConsole\.channel(\d+)\.(.+)$/;
const BANK_ACTIONS = { mNextBank: 'next', mPrevBank: 'prev', mResetBank: 'reset', mShiftLeft: 'shiftLeft', mShiftRight: 'shiftRight' };
const QC_PATH = /mQuickControls\[\d+\]$/;
const FOCUSED_QC_PATH = /mFocusedQuickControls\[\d+\]$/;
const CONTROL_ROOM_PATH = /^host\.mControlRoom\./;
const SELECTION_VALUES = 'host.mTrackSelection.mMixerChannel.mValue.';

/** Plugins of the selected track by slot key; null or absent is an empty slot, missing: true a plugin that is not installed. */
export const DEFAULT_PLUGINS = {
  'sel.ins.0': { name: 'Compressor', vendor: 'Steinberg Media Technologies' },
  'sel.strip.gate': { name: 'Gate', vendor: 'Steinberg Media Technologies' },
  'sel.strip.compressor': { name: 'Standard Compressor', vendor: 'Steinberg Media Technologies' },
  'sel.strip.tools': { name: 'EnvelopeShaper', vendor: 'Steinberg Media Technologies' },
  'sel.strip.saturator': { name: 'Tape Saturation', vendor: 'Steinberg Media Technologies' },
  'sel.strip.limiter': { name: 'Brickwall Limiter', vendor: 'Steinberg Media Technologies' },
};

/** Slot key (sel.ins.N, sel.strip.<module>, sel.inst) of a plugin slot host path, null for other paths. */
function slotKeyOf(path) {
  const insert = /viewer\(MCP Insert (\d+)\)$/.exec(path);
  if (insert) return `sel.ins.${insert[1]}`;
  const strip = /mStripEffects\.m(\w+)$/.exec(path);
  if (strip) return `sel.strip.${strip[1].toLowerCase()}`;
  return /mInstrumentPluginSlot$/.test(path) ? 'sel.inst' : null;
}

function defaultValue(path) {
  if (/mVolume$/.test(path)) return 0.8;
  if (/mPan$/.test(path)) return 0.5;
  if (/mGain$/.test(path)) return 0.5;
  return 0;
}

/**
 * Channel EQ type names per band, as the mock shows them (band 1 and bands 2/3 as read live on 14 Oct 2026; band 4
 * mirrors band 1). Tests can change them (a Cubase whose list differs).
 */
export const EQ_TYPE_NAMES = {
  1: ['Parametric I', 'Low Shelf I', 'High Pass I', 'High Pass II', 'Parametric II', 'Low Shelf II', 'Low Shelf III', 'Low Shelf IV'],
  2: ['Parametric I', 'Parametric II'],
  3: ['Parametric I', 'Parametric II'],
  4: ['Parametric I', 'High Shelf I', 'Low Pass I', 'Low Pass II', 'Parametric II', 'High Shelf II', 'High Shelf III', 'High Shelf IV'],
};

function displayFor(path, v) {
  if (/mVolume$|mLevel$/.test(path)) {
    if (v <= 0.0001) return ['-oo', 'dB'];
    const db = 6 + 40 * Math.log10(v); // monotonic, +6 dB at 1.0
    return [db.toFixed(2), 'dB'];
  }
  if (/mPan$/.test(path)) {
    const pan = Math.round((v - 0.5) * 200);
    return [pan === 0 ? 'C' : pan < 0 ? `L${-pan}` : `R${pan}`, ''];
  }
  if (/Freq$/.test(path)) {
    const hz = 20 * Math.pow(1000, v);
    return hz >= 1000 ? [(hz / 1000).toFixed(2), 'kHz'] : [hz.toFixed(1), 'Hz'];
  }
  // Pre-filter slopes: 0, 0.25, 0.5, 0.75, 1 are 6, 12, 24, 36, 48 dB/Oct.
  if (/CutSlope$/.test(path)) return [String([6, 12, 24, 36, 48][Math.round(v * 4)]), 'dB/Oct'];
  // Pre-section input gain goes from -48 to +48 dB, EQ band gain from -24 to +24 dB.
  if (/mPreFilter\.mGain$/.test(path)) return [(-48 + 96 * v).toFixed(2), 'dB'];
  if (/mGain$/.test(path)) return [(-24 + 48 * v).toFixed(2), 'dB'];
  // Channel EQ Q: 0.0 at normalized 0 up to 12 (live, 14 Oct 2026); the mock makes it linear.
  if (/mQ$/.test(path)) return [(12 * v).toFixed(2), ''];
  // Channel EQ filter types: bands 1 and 4 have 8 in steps of k/7, bands 2 and 3 two (0 and 1).
  const band = /mBand(\d)\.mFilterType$/.exec(path);
  if (band) {
    const types = EQ_TYPE_NAMES[band[1]];
    return [types[Math.min(types.length - 1, Math.floor(v * (types.length - 1) + 1e-6))], ''];
  }
  return [v.toFixed(3), ''];
}

/**
 * options.hiddenOutOfBank: hidden channels stay out of the bank even with followVisibility off (Cubase 13 live).
 * options.tracks: MixConsole channels in order (default TRACKS); options.hidden: indexes of channels hidden in
 * the MixConsole (they drop out of the bank when the script lets it follow visibility).
 * The bank moves like Cubase's: by offset, next = min(offset + size, total - 1), prev = max(offset - size, 0).
 * state.bankDelayMs delays bank moves, state.titleDelayMs leaves titles empty for a while after a move, and
 * state.dropBankActions makes the bank ignore that many actions (a lost MIDI message).
 *
 * MIDI Remote stalls and Cubase's late callbacks:
 * - state.requestLog lists every complete request the server sent ({ id, method, params, session, at }),
 *   and state.onRequest(request) is called for each one before it reaches the script.
 * - state.dropRequests: that many requests never reach the script.
 * - state.dropReplies: the script runs that many requests but their answers are lost.
 * - state.stallUntil (ms timestamp): until then the script runs requests but every answer is lost.
 * - state.delayNextReplyMs: the next answer arrives that late (a late answer to a timed-out request).
 * - state.lag: [{ pattern: RegExp, ms }] delays host values whose path matches (Cubase applying switches
 *   and the selection seconds after the write); state.ignored: RegExp of host paths that ignore writes.
 * - state.meterLevels: { [channel title]: normalized meter level } the meters reach while playing.
 *
 * Solo, as Cubase shows it (state.soloView, on by default): while any channel is soloed, the bank shows
 * solo-implied states instead of the real switches: the other channels read mute 1, the soloed channel reads
 * mute 0 and the channels it feeds (state.soloDestinations, default: titles ending in "Out") read solo 1.
 * The real switches stay in project[i].values ('mValue.mMute', 'mValue.mSolo').
 * state.directParams[path] holds the DirectAccess parameters of the plugin loaded in each slot.
 *
 * MIDI channels (options.kinds naming them "MIDI N"): like Cubase, they have no Pre section and no sends, so their
 * bank slot gets no values (nor send titles) for those: it keeps the ones of the channel it showed before, or none.
 * state.unrecordedHistory: RegExp of host paths whose writes leave no MixConsole History step (like some of the
 * seek writes in the live test of 15 Oct 2026).
 *
 * options.plugins: plugins of the selected track by slot key, over DEFAULT_PLUGINS (see there).
 * options.controlRoom: false makes Control Room disabled: its values stay empty, writes do nothing and its
 * DirectAccess scope answers the MixConsole root, like Cubase. options.daNodesPerChannel: extra child objects of
 * each channel in the DirectAccess mixer tree (Cubase has ~74 nodes per channel).
 * state.recordFollowsSelection: selecting a channel record-arms it and disarms the one selected before (Cubase's
 * "Enable Record on Selected Audio Track"). Selecting is exclusive, and the sel.* values take the channel's title.
 * Quick controls without a parameter (mock.setValueTitle assigns one) show no display and drop writes: the track
 * ones apply 0, the focused ones apply the previous write (one write behind).
 * track.next / track.prev move the selection along the project channels and do nothing at the ends.
 */
/** DirectAccess internal name of a channel, like Cubase's ("Audio 14", "GroupChannel 3", "OutputChannel"). options.kinds: { title: name }. */
function uniqueNameFor(title, i, kinds = {}) {
  if (kinds[title]) return kinds[title];
  if (/Out$/.test(title)) return 'OutputChannel';
  if (/^(Group|.*\bBUSS?\b)/i.test(title)) return `GroupChannel ${i}`;
  if (/^FX\b/i.test(title)) return `FxChannel ${i}`;
  if (/^VCA\b/i.test(title)) return `VCA ${i}`;
  return `Audio ${i}`;
}

/** "H:MM:SS.mmm", as Cubase shows the transport time. */
function formatTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
}

function parseTime(text) {
  const match = /^\s*(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*$/.exec(String(text));
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

/** Project length the transport time is normalized to. */
const TIME_RANGE = 3600;

export function createMockCubase(options = {}) {
  const project = (options.tracks ?? TRACKS).map((title, i) => ({ title, uid: `uid-${i}-${title}`, values: new Map(), uniqueName: uniqueNameFor(title, i, options.kinds) }));
  /** Bank slot fields a MIDI channel does not have: Cubase leaves them alone when the slot shows one. */
  const isMidi = (channel) => /^MIDI\b/i.test(channel?.uniqueName ?? '');
  const MIDI_MISSING = /^(mPreFilter\.|mSends\[)/;
  /** Channels hidden in the MixConsole (state.hidden; Channel & Track Visibility / ShowAll shows them all again). */
  const hidden = new Set((options.hidden ?? []).map((i) => project[i]));
  const state = {
    project,
    hidden,
    /** Like Cubase 13 live: hidden channels stay out of the bank even when the script asks it not to follow visibility. */
    hiddenOutOfBank: options.hiddenOutOfBank ?? false,
    /** ShowAll does nothing (as the catalog label did live before internal names). */
    showAllIgnored: false,
    /** DirectAccess renames (tag 1024 "Name") do nothing. */
    renameIgnored: false,
    bankOffset: 0,
    followVisibility: undefined,
    bankDelayMs: 0,
    titleDelayMs: 0,
    dropBankActions: 0,
    requestLog: [],
    onRequest: null,
    dropRequests: 0,
    dropReplies: 0,
    stallUntil: 0,
    delayNextReplyMs: 0,
    lag: [],
    ignored: null,
    meterLevels: {},
    soloView: options.soloView ?? true,
    soloDestinations: options.soloDestinations ?? null,
    directParams: {},
    plugins: { ...DEFAULT_PLUGINS, ...(options.plugins ?? {}) },
    controlRoom: options.controlRoom ?? true,
    recordFollowsSelection: options.recordFollowsSelection ?? false,
    /** False after a track without mixer channel got selected. */
    selectionHasChannel: false,
    assignedQc: new Set(),
    qcLastWrite: new Map(),
    /** Plugin slot host path -> node whose mOnChangePluginIdentity the script set. */
    pluginSlots: new Map(),
    /** Host path -> the script's custom variable bound to it. */
    boundVars: new Map(),
    commandsRun: [],
    crashingCalls: [],
    actionsRun: [],
    /** Transport: marker number -> seconds, cycle marker number -> [left, right] (none by default, like the live test project). */
    markers: {},
    cycleMarkers: {},
    projectEnd: 306.786,
    /** One bar (4/4 at 120 BPM) for stepBar/stepBackBar, and how far nudgeUp/nudgeDown move the cursor. */
    barSeconds: 2,
    nudgeSeconds: 1,
    /** The DirectAccess transport buttons (stepBar, nudgeUp...) do nothing. */
    transportButtonsIgnored: false,
    /** Group/FX creation opens the modal "Añadir pista" dialog (it waits for mock.confirmDialog()). */
    busDialog: false,
    pendingDialog: null,
    /** Where Cubase inserts a new bus channel (index in MixConsole order). */
    busInsertIndex: 5,
    busCount: 0,
    /** Channel -> output bus name (DirectAccess "Salida", tag 4102); default "Stereo Out". */
    outputs: new Map(),
    /** Called with (category, name) for every key command Cubase runs. */
    onCommand: null,
    /** Edit history (bus creations) and MixConsole history (fader, pan and input gain writes; never mute or solo, like Cubase). */
    editHistory: [],
    unrecordedHistory: null,
    redoIgnored: false,
    mixHistory: [],
    mixRedo: [],
    hostValues: new Map(),
    selectedIndex: -1,
    bankChannels: [],
    selectedNode: null,
    outputListener: null,
    /** Every server connected to the buses gets every answer, like two processes on the same IAC bus. */
    outputListeners: new Set(),
    midiInput: null,
    page: null,
    deviceDriver: null,
    logs: [],
  };
  const activeDevice = { id: 'device' };
  const activeMapping = { id: 'mapping' };

  function hostNode(path) {
    const props = {};
    const children = {};
    const node = new Proxy(props, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== 'string') return undefined;
        if (prop === '__path') return path;
        // mOnXxx are callbacks the script sets; mOn itself is a value (send, insert and module on).
        const callback = /^mOn[A-Z]/.test(prop);
        if (/^m[A-Z]/.test(prop) && !callback) {
          if (!children[prop]) children[prop] = hostNode(`${path}.${prop}`);
          return children[prop];
        }
        if (callback) return undefined;
        switch (prop) {
          case 'getSize':
            return () => 8;
          case 'getByIndex':
            return (i) => {
              const key = `[${i}]`;
              if (!children[key]) children[key] = hostNode(`${path}${key}`);
              return children[key];
            };
          case 'makeMixerBankChannel':
            return () => {
              const channel = hostNode(`${path}.channel${state.bankChannels.length}`);
              state.bankChannels.push(channel);
              return channel;
            };
          case 'makeInsertEffectViewer':
            return (name) => hostNode(`${path}.viewer(${name})`);
          case 'getUniqueIDString':
            return () => {
              // Real Cubase 13 crashes (strlen on a null string, 15 Oct 2026) when this is called on
              // an object bound to nothing: an empty bank slot or a selection without mixer channel.
              const slot = /^host\.mMixConsole\.channel(\d+)$/.exec(path);
              if (slot) {
                const channel = bankChannel(Number(slot[1]));
                if (!channel) state.crashingCalls.push(`getUniqueIDString ${path}`);
                return channel?.uid ?? '';
              }
              if (path === 'host.mTrackSelection.mMixerChannel') {
                if (!state.selectionHasChannel) state.crashingCalls.push(`getUniqueIDString ${path}`);
                return state.selectionHasChannel ? (state.project[state.selectedIndex]?.uid ?? '') : '';
              }
              return `uid:${path}`;
            };
          case 'setFollowVisibility':
            return (follow) => {
              state.followVisibility = follow;
              return node;
            };
          case 'getRuntimeID':
            return () => 1;
          default:
            return () => node; // chaining methods: include*, accessSlotAtIndex, setFollowVisibility...
        }
      },
      set(target, prop, value) {
        target[prop] = value;
        if (prop === 'mOnChangePluginIdentity') state.pluginSlots.set(path, node);
        return true;
      },
    });
    return node;
  }

  function customVar(name) {
    const cv = {
      name,
      value: 0,
      bindings: [],
      setProcessValue(device, v) {
        cv.value = v;
        for (const binding of cv.bindings) binding(v);
      },
      getProcessValue: () => cv.value,
    };
    return cv;
  }

  /**
   * DirectAccess objects, in one registry like Cubase's object ids. Like Cubase 13, an unknown object id
   * answers -1 for its counts and '' for its title, an unknown tag -1 for its value and '-' for its title,
   * and writes to either do nothing.
   */
  const objects = new Map();
  let nextObjectId = 100;
  const MIXER_ROOT = 27;
  function addObject(spec) {
    const id = spec.id ?? nextObjectId++;
    objects.set(id, { title: '', typeName: 'Object', params: {}, hidden: {}, children: [], uid: `uid${id}`, mixerIndex: -1, ...spec, id });
    return id;
  }
  const switchDisplay = (on, off) => (v) => [v >= 0.5 ? on : off, ''];
  function pluginParams(path) {
    const params = {
      10: { title: 'Threshold', value: 0.5, toDisplay: (v) => [(-60 + 60 * v).toFixed(1), 'dB'] },
      11: { title: 'Ratio', value: 0.2, toDisplay: (v) => [(1 + 19 * v).toFixed(2), ''] },
      12: { title: 'Attack', value: 0.1, toDisplay: (v) => [(0.1 + 99.9 * v).toFixed(1), 'ms'] },
    };
    // The strip compressor also has a switch and a mode list, like Cubase's (AutoMakeUp shows "On"/"Off").
    if (/mCompressor$/.test(path)) {
      params[13] = { title: 'AutoMakeUp', value: 0, toDisplay: switchDisplay('On', 'Off') };
      params[14] = { title: 'Character', value: 0, toDisplay: (v) => [['Clean', 'Vintage', 'Punch'][Math.min(2, Math.floor(v * 3))], ''] };
      // A meter Cubase ignores writes to, and a title that contains another one ("Ratio").
      params[15] = { title: 'GR', value: 0, readOnly: true, toDisplay: (v) => [(-20 * v).toFixed(1), 'dB'] };
      params[16] = { title: 'Ratio Mode', value: 0, toDisplay: switchDisplay('Soft', 'Hard') };
    }
    return params;
  }
  /** The mixer tree: root 27 "VST Mixer", one object per channel, each with Input Filter, EQ and options.daNodesPerChannel more. */
  let mixerBuilt = false;
  const channelObject = new Map();
  const outputOf = (channel) => state.outputs.get(channel) ?? (channel.uniqueName === 'OutputChannel' ? 'Sin bus' : 'Stereo Out');
  function addChannelObject(channel) {
    const inputFilter = addObject({
      title: 'Input Filter',
      params: {
        4100: { title: 'Gain', value: 0.5, toDisplay: (v) => [(-48 + 96 * v).toFixed(2), 'dB'] },
        4101: { title: 'Phase', value: 0, toDisplay: switchDisplay('Activ.', 'Desact.') },
      },
    });
    const eq = addObject({
      title: 'EQ',
      params: { 4200: { title: 'EQ 1 Gain', value: 0.5, toDisplay: (v) => [(-24 + 48 * v).toFixed(2), 'dB'] } },
    });
    const filler = Array.from({ length: options.daNodesPerChannel ?? 0 }, (_, k) => addObject({ title: `Node ${k}` }));
    const id = addObject({
      title: channel.title,
      typeName: 'MixerChannel',
      uniqueName: channel.uniqueName,
      uid: channel.uid,
      // DirectAccess numbering: Stereo Out is -1 and the input channels count (not the bank index).
      get mixerIndex() {
        return channel.title === 'Stereo Out' ? -1 : state.project.indexOf(channel) + 1;
      },
      params: {
        4096: { title: 'Volume', value: 0.8, toDisplay: (v) => displayFor('mVolume', v) },
        4097: { title: 'Mute', value: 0, toDisplay: switchDisplay('Activ.', 'Desact.') },
        // The output: Cubase shows the bus and ignores writes to it (by display, and its value is a bus id).
        4102: { title: 'Salida', value: 0, readOnly: true, toDisplay: () => [outputOf(channel), ''] },
      },
      // Readable by tag but not in the indexed list, like the channel name in Cubase. Writing its display renames the
      // channel (live, 15 Oct 2026: no Edit history step); a blank text is ignored.
      hidden: {
        1024: {
          title: 'Name',
          value: 0,
          toDisplay: () => [channel.title, ''],
          fromDisplay: (text) => {
            const name = String(text).trim();
            if (!name || state.renameIgnored) return undefined;
            renameChannel(channel, name);
            return 0;
          },
        },
      },
      channel,
      children: [inputFilter, eq, ...filler],
    });
    channelObject.set(channel, id);
    return id;
  }
  function buildMixer() {
    if (mixerBuilt) return;
    mixerBuilt = true;
    project.forEach((channel) => addChannelObject(channel));
    addObject({ id: MIXER_ROOT, title: 'VST Mixer', typeName: 'MixConsole' });
    // Channels added later (new buses) appear in MixConsole order.
    Object.defineProperty(objects.get(MIXER_ROOT), 'children', {
      get: () => state.project.map((channel) => channelObject.get(channel) ?? addChannelObject(channel)),
    });
  }
  /** The transport object: time and cycle locators (tags 4023, 4030, 4031), set by display like Cubase ("0:01:23.000"). */
  // With the primary time format on bars and beats (4025 below 0.125) Cubase shows "80. 2. 3. 75" and reads a
  // written "0:01:54.816" as bars and beats too, so it lands somewhere else (bar 3 in the live test of 15 Oct 2026).
  const barsFormat = () => (transportParams[4025]?.value ?? 0.25) < 0.125;
  const timeParam = (title, seconds) => ({
    title,
    value: seconds / TIME_RANGE,
    toDisplay: (v) => {
      if (!barsFormat()) return [formatTime(v * TIME_RANGE), ''];
      const beats = (v * TIME_RANGE) / (state.barSeconds / 4);
      return [`${Math.floor(beats / 4) + 1}. ${Math.floor(beats % 4) + 1}. 1.  0`, ''];
    },
    fromDisplay: (text) => {
      const parsed = parseTime(text);
      if (parsed === null) return undefined;
      return Math.min(1, Math.max(0, (barsFormat() ? parsed / 40 : parsed) / TIME_RANGE));
    },
  });
  const transportParams = {
    4023: timeParam('time', 60),
    4030: timeParam('cycleLeftTime', 182.439),
    4031: timeParam('cycleRightTime', 191.385),
  };
  const transportTime = {
    get: (tag = 4023) => Math.round(transportParams[tag].value * TIME_RANGE * 1000) / 1000,
    set: (seconds, tag = 4023) => {
      transportParams[tag].value = Math.max(0, seconds) / TIME_RANGE;
    },
  };
  /**
   * The other parameters of Cubase 13's transport object (101 in the live read of 14 Oct 2026, titles as Cubase
   * gives them; there is no tempo among them). Buttons act when written 1 (write 0 after, like the live test):
   * returnToZero 1, gotoEnd 2, gotoNextMarker 3, gotoPrevMarker 4, stepBar 5, stepBackBar 6, nudgeUp 4096 and
   * nudgeDown 4097 (state.nudgeSeconds). state.transportButtonsIgnored makes them do nothing.
   */
  const button = (title, act) => ({
    title,
    value: 0,
    toDisplay: switchDisplay('Activ.', 'Desact.'),
    onSet: (v, previous) => {
      if (act && v >= 0.5 && previous < 0.5 && !state.transportButtonsIgnored) act();
    },
  });
  const fixed = (title, value, display) => ({ title, value, readOnly: true, toDisplay: () => [display, ''] });
  const transportButtons = {
    4015: 'start', 4016: 'stop', 4017: 'forward', 4018: 'rewind', 4113: 'fastForward', 4112: 'fastRewind', 4019: 'record', 4116: 'onButtonRecord',
    4020: 'punchIn', 4021: 'punchOut', 4022: 'cycle', 4105: 'swapTimeFormats', 4034: 'syncActive', 4099: 'metronomeOn', 4100: 'precountOn',
    4036: 'editMode', 4037: 'usePreRoll', 4038: 'usePostRoll', 4117: 'recordLock', 4148: 'returnOnStop', 1304: 'markerButtonL', 1305: 'markerButtonR',
    0: 'markerWindow', 4118: 'setCycleOnLocateMarker', 4130: 'syncPunchToCycle', 4041: 'jogActive', 4114: 'jogLeft', 4115: 'jogRight',
    4045: 'nudgeUpFrame', 4046: 'nudgeDownFrame', 4121: 'snarecord', 4122: 'snaoverdub', 4123: 'snalatch', 4129: 'channelRotationMode',
  };
  for (const [tag, title] of Object.entries(transportButtons)) transportParams[tag] = button(title);
  for (let n = 1; n <= 15; n++) transportParams[1199 + n] = button(`markerButton${n}`);
  ['1x', '2x', '4x', '8x'].forEach((speed, i) => {
    transportParams[2000 + i] = button(`shuttleFw ${speed}`);
    transportParams[2004 + i] = button(`shuttleBw ${speed}`);
  });
  ['1/2x', '1/4x', '1/8x'].forEach((speed, i) => {
    transportParams[2008 + i] = button(`shuttleFw ${speed}`);
    transportParams[2011 + i] = button(`shuttleBw ${speed}`);
  });
  transportParams[4130].value = 1;
  const barAt = (t, direction) => {
    const bar = state.barSeconds;
    const index = t / bar;
    const onBar = Math.abs(index - Math.round(index)) < 1e-6;
    return direction > 0 ? (Math.floor(index + 1e-6) + 1) * bar : (onBar ? Math.round(index) - 1 : Math.floor(index)) * bar;
  };
  Object.assign(transportParams, {
    1: button('returnToZero', () => transportTime.set(0)),
    2: button('gotoEnd', () => transportTime.set(state.projectEnd)),
    3: button('gotoNextMarker', () => locateMarker(1)),
    4: button('gotoPrevMarker', () => locateMarker(-1)),
    5: button('stepBar', () => transportTime.set(barAt(transportTime.get(), 1))),
    6: button('stepBackBar', () => transportTime.set(barAt(transportTime.get(), -1))),
    4096: button('nudgeUp', () => transportTime.set(transportTime.get() + state.nudgeSeconds)),
    4097: button('nudgeDown', () => transportTime.set(transportTime.get() - state.nudgeSeconds)),
    4101: fixed('time2', 0, '31. 1. 1.   0'),
    4024: { ...timeParam('displayTime', 0), readOnly: true, toDisplay: () => [formatTime(transportTime.get()), ''] },
    4028: { ...timeParam('punchInTime', 0), readOnly: true, toDisplay: () => [formatTime(transportTime.get(4030)), ''] },
    4029: { ...timeParam('punchOutTime', 0), readOnly: true, toDisplay: () => [formatTime(transportTime.get(4031)), ''] },
    4051: fixed('cycleDuration', 0, '0:00:08.945'),
    4032: fixed('preRoll', 0, '0.000'),
    4033: fixed('postRoll', 0, '0.000'),
    4025: { title: 'timeFormat', value: 0.25, toDisplay: (v) => [v < 0.125 ? 'Compases+Tiempos' : 'Segundos', ''] },
    4102: fixed('timeFormat2', 0, 'Compases+Tiempos'),
    4103: fixed('timeDomain', 0.0714, 'Segundos'),
    4104: fixed('timeDomain2', 0, 'Compases+Tiempos'),
    4027: fixed('signature', 2621.48, '4/4'),
    4050: fixed('barCount', 0, '190'),
    4098: fixed('message', 1, 'OFFLINE'),
    4125: fixed('displayOffset', 0.5, '0:00:00.000'),
    4127: fixed('recordButtonMode', 0, 'Punch in/out'),
    4119: fixed('audioRecordMode', 0, 'Mantener historial'),
    4106: fixed('midiRecordMode', 0, 'Nuevas partes'),
    4107: fixed('midiCycleRecordMode', 0.75, 'Apilado'),
    4120: fixed('midiRecordModesDisplay', 1, 'Nuevas partes'),
    4143: fixed('startPlayModes', 0, 'Inicio desde posición del cursor de proyecto'),
    4109: fixed('recordStartMode', 0, 'Iniciar en cursor'),
    4110: fixed('midiInActivity', 0, '0'),
    4111: fixed('midiOutActivity', 0, '0'),
    4042: fixed('shuttleMode', 1, '1'),
    4043: fixed('shuttleSpeed', 0.5, '500'),
    4044: fixed('jog', 0.5, '500'),
  });
  /** Locate Next/Previous Marker: the next (previous) position marker, else the project end (start), like Cubase 13 live. */
  function locateMarker(direction) {
    const t = transportTime.get();
    const positions = Object.values(state.markers).sort((a, b) => a - b);
    if (direction > 0) {
      const next = positions.find((p) => p > t + 0.0005);
      transportTime.set(next ?? Math.max(t, state.projectEnd));
    } else {
      const previous = [...positions].reverse().find((p) => p < t - 0.0005);
      transportTime.set(previous ?? 0);
    }
  }

  /** Plugin slots: the slot object (own controls) and, when a plugin is loaded and installed, the plugin below it. */
  function slotObject(path) {
    const key = slotKeyOf(path);
    const identity = pluginFor(key);
    const children = [];
    if (identity && !identity.missing) {
      const params = pluginParams(path);
      state.directParams[path] = params;
      children.push(addObject({ title: identity.name, typeName: 'Plugin', params }));
    }
    const kind = identity ? (identity.missing ? `!!! ${identity.name} !!!` : identity.name) : 'Ningún efecto';
    return addObject({
      title: `Slot ${key}`,
      typeName: 'Slot',
      params: {
        4096: { title: 'Activ.', value: 1, toDisplay: switchDisplay('Activ.', 'Desact.') },
        4097: { title: 'Bypass', value: 0, toDisplay: switchDisplay('Activ.', 'Desact.') },
        4098: { title: 'Tipo de efecto', value: 0, toDisplay: () => [kind, ''] },
      },
      children,
    });
  }

  function directAccess(hostObject) {
    const path = hostObject.__path ?? '';
    let base;
    if (path === 'host.mMixConsole') base = () => (buildMixer(), MIXER_ROOT);
    else if (path === 'host.mTrackSelection.mMixerChannel') {
      base = () => {
        buildMixer();
        const channel = state.selectionHasChannel ? state.project[state.selectedIndex] : undefined;
        return channel ? channelObject.get(channel) : -1;
      };
    } else if (path === 'host.mTransport') {
      const own = addObject({ id: 20, title: 'Transport', typeName: 'Transport', params: transportParams });
      base = () => own;
    } else if (path === 'host.mControlRoom') {
      const own = addObject({ title: 'Control Room', params: { 4300: { title: 'Main Level', value: 0.5, toDisplay: (v) => [(-60 + 66 * v).toFixed(1), 'dB'] } } });
      // Disabled, Cubase answers the MixConsole root for this scope.
      base = () => (state.controlRoom ? own : (buildMixer(), MIXER_ROOT));
    } else if (slotKeyOf(path)) {
      const own = slotObject(path);
      base = () => own;
    } else {
      const own = addObject({ title: path.split('.').pop() ?? 'Object', params: { 4400: { title: 'Value', value: 0, toDisplay: (v) => [v.toFixed(3), ''] } } });
      base = () => own;
    }
    const object = (id) => objects.get(id);
    const indexed = (o) => Object.keys(o.params).map(Number);
    const param = (id, tag) => {
      const o = object(id);
      return o ? (o.params[tag] ?? o.hidden[tag]) : undefined;
    };
    return {
      activated: false,
      activate() {
        this.activated = true;
      },
      deactivate() {
        this.activated = false;
      },
      update() {},
      getBaseObjectID: () => base(),
      getNumberOfChildObjects: (m, id) => object(id)?.children.length ?? -1,
      getChildObjectID: (m, id, i) => object(id)?.children[i] ?? -1,
      getObjectTitle: (m, id) => object(id)?.title ?? '',
      getObjectTypeName: (m, id) => object(id)?.typeName ?? '',
      getObjectUniqueName: (m, id) => (object(id) ? (object(id).uniqueName ?? `obj${id}`) : ''),
      getObjectUniqueIDString: (m, id) => object(id)?.uid ?? '',
      getObjectColor: () => 0,
      getNumberOfParameters: (m, id) => (object(id) ? indexed(object(id)).length : -1),
      getParameterTagByIndex: (m, id, i) => (object(id) ? (indexed(object(id))[i] ?? -1) : -1),
      getParameterTitle: (m, id, tag) => param(id, tag)?.title ?? '-',
      getParameterProcessValue: (m, id, tag) => param(id, tag)?.value ?? -1,
      setParameterProcessValue: (m, id, tag, v) => {
        const p = param(id, tag);
        if (!p || p.readOnly) return;
        const previous = p.value;
        p.value = v;
        p.onSet?.(v, previous);
      },
      getParameterDefaultProcessValue: () => 0.5,
      getParameterDisplayValue: (m, id, tag) => {
        const p = param(id, tag);
        return p ? p.toDisplay(p.value)[0] : '';
      },
      getParameterDisplayUnits: (m, id, tag) => {
        const p = param(id, tag);
        return p ? p.toDisplay(p.value)[1] : '';
      },
      setParameterDisplayValue: (m, id, tag, text) => {
        const p = param(id, tag);
        if (!p || p.readOnly) return;
        if (p.fromDisplay) {
          const v = p.fromDisplay(text);
          if (v !== undefined) p.value = v;
          return;
        }
        // Like Cubase: a text the parameter shows ("On", "Vintage") or a number; anything else is ignored.
        const grid = Array.from({ length: 1001 }, (_, i) => i / 1000);
        const same = grid.find((v) => p.toDisplay(v)[0].toLowerCase() === String(text).trim().toLowerCase());
        if (same !== undefined) {
          p.value = same;
          return;
        }
        if (!Number.isFinite(Number(text)) || String(text).trim() === '') return;
        let best = 0;
        let bestError = Infinity;
        for (const v of grid) {
          const error = Math.abs(Number(p.toDisplay(v)[0]) - Number(text));
          if (error < bestError) {
            bestError = error;
            best = v;
          }
        }
        p.value = best;
      },
      getParameterEditLockState: () => false,
      setParameterEditLockState: () => {},
      getMixerChannelIndex: (m, id) => object(id)?.mixerIndex ?? -1,
      isMixerChannelVisible: (m, id) => (object(id)?.channel ? !hidden.has(object(id).channel) : true),
    };
  }

  /** Channels the bank can show: hidden ones drop out only while the bank follows visibility (Cubase's default). */
  function bankList() {
    return state.followVisibility === false && !state.hiddenOutOfBank ? state.project : state.project.filter((channel) => !hidden.has(channel));
  }

  /** A rename (DirectAccess "Name"): the bank slot showing the channel, the tree and the selection get the new title. */
  function renameChannel(channel, name) {
    channel.title = name;
    const id = channelObject.get(channel);
    if (id !== undefined) objects.get(id).title = name;
    state.bankChannels.forEach((slot, i) => {
      if (bankChannel(i) === channel) slot.mOnTitleChange?.(activeDevice, activeMapping, name);
    });
    if (state.selectionHasChannel && state.project[state.selectedIndex] === channel) state.selectedNode.mOnTitleChange?.(activeDevice, activeMapping, name);
  }

  function bankChannel(slot) {
    return bankList()[state.bankOffset + slot];
  }

  function pluginFor(key) {
    return key ? (state.plugins[key] ?? null) : null;
  }

  /** Sets a field of a project channel and, when the bank shows it, of its slot. */
  function setChannelField(channel, field, v) {
    channel.values.set(field, v);
    const slot = state.bankChannels.findIndex((_, i) => bankChannel(i) === channel);
    if (slot >= 0) setHostValue(`host.mMixConsole.channel${slot}.${field}`, v);
  }

  /** Selects a project channel like Cubase: exclusive, the selection object and its values follow it. */
  function selectChannel(channel) {
    const previous = state.selectionHasChannel ? state.project[state.selectedIndex] : undefined;
    if (previous && previous !== channel) {
      setChannelField(previous, 'mValue.mSelected', 0);
      if (state.recordFollowsSelection) setChannelField(previous, 'mValue.mRecordEnable', 0);
    }
    state.selectedIndex = state.project.indexOf(channel);
    state.selectionHasChannel = true;
    if (channel.values.get('mValue.mSelected') !== 1) setChannelField(channel, 'mValue.mSelected', 1);
    if (state.recordFollowsSelection) setChannelField(channel, 'mValue.mRecordEnable', 1);
    state.selectedNode.mOnTitleChange?.(activeDevice, activeMapping, channel.title);
    // The sel.* values name the channel that owns them (their object title).
    for (const [path, cv] of state.boundVars) {
      if (path.startsWith(SELECTION_VALUES)) cv.mOnTitleChange?.(activeDevice, channel.title, path.slice(SELECTION_VALUES.length + 1));
    }
    setHostValue(SELECTED_FLAG_PATH, 1);
  }

  const SOLO_FIELD = /^mValue\.m(Mute|Solo)$/;
  const realSwitch = (channel, field) => channel.values.get(field) ?? 0;
  const isDestination = (channel) => (state.soloDestinations ? state.soloDestinations.includes(channel.title) : /Out$/.test(channel.title));

  /** What Cubase shows for a channel's mute or solo: solo-implied states while any channel is soloed. */
  function shownSwitch(channel, field) {
    const real = realSwitch(channel, field);
    if (!state.soloView || !state.project.some((c) => realSwitch(c, 'mValue.mSolo') > 0.5)) return real;
    const soloed = realSwitch(channel, 'mValue.mSolo') > 0.5;
    if (field === 'mValue.mSolo') return soloed || isDestination(channel) ? 1 : 0;
    if (soloed) return 0;
    return isDestination(channel) ? real : 1;
  }

  /** Pushes the shown mute and solo of every bank slot again (after a solo or mute changed). */
  function refreshSoloView() {
    for (const [path, record] of state.hostValues) {
      const slot = SLOT_PATH.exec(path);
      if (!slot || !SOLO_FIELD.test(slot[2])) continue;
      const channel = bankChannel(Number(slot[1]));
      if (!channel) continue;
      const v = shownSwitch(channel, slot[2]);
      if (record.value === v) continue;
      record.value = v;
      for (const listener of record.listeners) listener(v);
    }
  }

  /** Shows the channels of the current offset in the bank slots, like Cubase's callbacks after a bank move. */
  function showBank() {
    const titles = () =>
      state.bankChannels.forEach((channel, i) => channel.mOnTitleChange?.(activeDevice, activeMapping, bankChannel(i)?.title ?? ''));
    for (const [path, record] of state.hostValues) {
      const slot = SLOT_PATH.exec(path);
      const channel = slot && bankChannel(Number(slot[1]));
      // Like Cubase, an empty slot keeps its last values, and so do the fields a MIDI channel does not have.
      if (!channel || (isMidi(channel) && MIDI_MISSING.test(slot[2]))) continue;
      const v = SOLO_FIELD.test(slot[2]) ? shownSwitch(channel, slot[2]) : channel.values.has(slot[2]) ? channel.values.get(slot[2]) : defaultValue(path);
      record.value = v;
      for (const listener of record.listeners) listener(v);
    }
    if (state.titleDelayMs > 0) {
      state.bankChannels.forEach((channel) => channel.mOnTitleChange?.(activeDevice, activeMapping, ''));
      setTimeout(titles, state.titleDelayMs);
    } else titles();
  }

  function moveBank(action) {
    if (state.dropBankActions > 0) {
      state.dropBankActions--;
      return;
    }
    const apply = () => {
      const last = Math.max(bankList().length - 1, 0);
      const size = state.bankChannels.length;
      const o = state.bankOffset;
      state.bankOffset = { next: Math.min(o + size, last), prev: Math.max(o - size, 0), reset: 0, shiftLeft: Math.max(o - 1, 0), shiftRight: Math.min(o + 1, last) }[action];
      if (state.bankOffset !== o) showBank();
    };
    if (state.bankDelayMs > 0) setTimeout(apply, state.bankDelayMs);
    else apply();
  }

  /** A new bus channel for the selected channel, inserted at state.busInsertIndex like Cubase (it shifts the bank indexes). */
  function createBus(type) {
    state.busCount++;
    const title = `${{ group: 'Group', fx: 'FX', vca: 'VCA' }[type]} ${state.busCount}`;
    const uniqueName = `${{ group: 'GroupChannel', fx: 'FxChannel', vca: 'VCA' }[type]} ${state.busCount}`;
    const channel = { title, uid: `uid-bus-${state.busCount}-${title}`, values: new Map(), uniqueName };
    const sources = state.project.filter((c) => c.values.get('mValue.mSelected') === 1);
    const previous = sources.map((c) => [c, state.outputs.get(c)]);
    if (type === 'group') sources.forEach((c) => state.outputs.set(c, title));
    state.project.splice(Math.min(state.busInsertIndex, state.project.length), 0, channel);
    state.editHistory.push({ kind: 'addTrack', channel, previous });
    showBank();
  }

  /** What Cubase does for the key commands the tests use: Transport/Start does nothing (as in the live test). */
  function runCommand(category, name) {
    state.onCommand?.(category, name);
    // "To Cycle Marker N" moves the cursor to the start of the range, "Recall Cycle Marker N" sets the locators to it.
    const marker = /^(To|Recall) (Cycle )?Marker (\d)$/.exec(name);
    if (category === 'Transport' && marker) {
      if (marker[2]) {
        const range = state.cycleMarkers[marker[3]];
        if (range && marker[1] === 'Recall') {
          if (state.cycleRecallIgnored) return;
          transportTime.set(range[0], 4030);
          transportTime.set(range[1], 4031);
        } else if (range) transportTime.set(range[0]);
      } else if (state.markers[marker[3]] !== undefined) transportTime.set(state.markers[marker[3]]);
      return;
    }
    const key = `${category} / ${name}`;
    if (key === 'Channel & Track Visibility / ShowAll') {
      if (state.showAllIgnored) return;
      hidden.clear();
      showBank();
      return;
    }
    const locate = {
      'Transport / Return to Zero': () => 0,
      'Transport / Goto End': () => state.projectEnd,
      'Transport / To Left Locator': () => transportTime.get(4030),
      'Transport / To Right Locator': () => transportTime.get(4031),
    }[key];
    if (locate) return transportTime.set(locate());
    const step = {
      'Transport / Locate Next Marker': () => locateMarker(1),
      'Transport / Locate Previous Marker': () => locateMarker(-1),
      'Transport / Step Bar': () => transportTime.set(barAt(transportTime.get(), 1)),
      'Transport / Step Back Bar': () => transportTime.set(barAt(transportTime.get(), -1)),
      'Transport / Nudge Cursor Right': () => transportTime.set(transportTime.get() + state.nudgeSeconds),
      'Transport / Nudge Cursor Left': () => transportTime.set(transportTime.get() - state.nudgeSeconds),
    }[key];
    if (step) return step();
    const bus = { 'Add Track To Selected: Group Channel': 'group', 'Add Track To Selected: FX Channel': 'fx', 'Add Track To Selected: VCA Fader': 'vca' }[name];
    if (category === 'Mixer' && bus) {
      if (state.busDialog && bus !== 'vca') state.pendingDialog = bus;
      else createBus(bus);
      return;
    }
    if (key === 'Edit / Undo') {
      const step = state.editHistory.pop();
      if (step?.kind === 'addTrack') {
        state.project.splice(state.project.indexOf(step.channel), 1);
        // Like Cubase: the sources lose their output ("Sin bus") instead of getting the old one back.
        for (const [source] of step.previous) state.outputs.set(source, 'Sin bus');
        showBank();
      }
      return;
    }
    if (key === 'MixConsole History / Undo MixConsole Step' || key === 'MixConsole History / Redo MixConsole Step') {
      const undo = name.startsWith('Undo');
      // Live (15 Oct 2026) a redo right after an undo did not bring the value back.
      if (!undo && state.redoIgnored) return;
      const step = (undo ? state.mixHistory : state.mixRedo).pop();
      if (!step) return;
      (undo ? state.mixRedo : state.mixHistory).push({ ...step, previous: step.channel.values.get(step.field) ?? 0 });
      recordingHistory = false;
      setChannelField(step.channel, step.field, step.previous);
      recordingHistory = true;
    }
  }
  let recordingHistory = true;

  function bindHostValue(cv, hostValue) {
    const path = hostValue.__path;
    state.boundVars.set(path, cv);
    if (!state.hostValues.has(path)) state.hostValues.set(path, { value: 0, listeners: [] });
    const record = state.hostValues.get(path);
    const notify = (v) => {
      // Bank slot values belong to the channel the slot shows.
      const slot = SLOT_PATH.exec(path);
      const channel = slot && bankChannel(Number(slot[1]));
      if (channel) channel.values.set(slot[2], v);
      if (channel && SOLO_FIELD.test(slot[2])) {
        // The real switch changed: every slot shows mute and solo again, solo-implied while a channel is soloed.
        record.value = undefined;
        refreshSoloView();
        return;
      }
      record.value = v;
      for (const listener of record.listeners) listener(v);
    };
    const quickControl = QC_PATH.test(path) || FOCUSED_QC_PATH.test(path);
    record.listeners.push((v) => {
      cv.value = v;
      const [display, units] = displayFor(path, v);
      cv.mOnProcessValueChange?.(activeDevice, v, 0);
      // A quick control without a parameter has no display.
      if (!quickControl || state.assignedQc.has(path)) cv.mOnDisplayValueChange?.(activeDevice, display, units);
    });
    const apply = (v) => {
      notify(v);
      // Like Cubase (B-91): switching automation write on switches read on too.
      const autoWrite = /^host\.mMixConsole\.channel(\d+)\.mValue\.mAutomationWrite$/.exec(path);
      if (autoWrite && v > 0.5) {
        const channel = bankChannel(Number(autoWrite[1]));
        if (channel) setChannelField(channel, 'mValue.mAutomationRead', 1);
      }
      // Selecting a bank channel updates the selected-track title and selected flag.
      const match = /channel(\d+)\.mValue\.mSelected$/.exec(path);
      if (match && v > 0.5) {
        const channel = bankChannel(Number(match[1]));
        if (channel) selectChannel(channel);
      }
      // Stop stops playback; playing drives the meters to state.meterLevels.
      if (path === 'host.mTransport.mValue.mStop' && v > 0.5) setHostValue('host.mTransport.mValue.mStart', 0);
      if (path === 'host.mTransport.mValue.mStart' && v > 0.5) {
        setImmediate(() =>
          state.bankChannels.forEach((_, i) => {
            const level = state.meterLevels[bankChannel(i)?.title];
            if (level !== undefined) setHostValue(`host.mMixConsole.channel${i}.mValue.mVUMeter`, level);
          }),
        );
      }
    };
    cv.bindings.push((v) => {
      if (state.ignored?.test(path)) return;
      // The MixConsole history records fader, pan and input gain writes (not mute or solo).
      const historySlot = SLOT_PATH.exec(path);
      const historyChannel = historySlot && /^(mValue\.m(Volume|Pan)|mPreFilter\.mGain)$/.test(historySlot[2]) && bankChannel(Number(historySlot[1]));
      if (historyChannel && recordingHistory && !state.unrecordedHistory?.test(path)) {
        state.mixHistory.push({ channel: historyChannel, field: historySlot[2], previous: historyChannel.values.get(historySlot[2]) ?? defaultValue(path) });
        state.mixRedo = [];
      }
      if (!state.controlRoom && CONTROL_ROOM_PATH.test(path)) return;
      if (quickControl && !state.assignedQc.has(path)) {
        // Nothing assigned: the track quick controls apply 0, the focused ones the previous write.
        const echo = FOCUSED_QC_PATH.test(path) ? (state.qcLastWrite.get(path) ?? 0) : 0;
        state.qcLastWrite.set(path, v);
        apply(echo);
        return;
      }
      const lag = state.lag.find((l) => l.pattern.test(path));
      if (lag) setTimeout(() => apply(v), lag.ms);
      else apply(v);
    });
    return record;
  }

  function setHostValue(path, v) {
    const record = state.hostValues.get(path);
    if (!record) return;
    record.value = v;
    for (const listener of record.listeners) listener(v);
  }

  /**
   * Like Cubase when a folder or MIDI track gets selected: the selection object's title goes empty, but its
   * sel.* values keep the old mixer channel (and its object title).
   */
  function selectTrackWithoutMixerChannel() {
    const previous = state.selectionHasChannel ? state.project[state.selectedIndex] : undefined;
    if (previous) previous.values.set('mValue.mSelected', 0);
    state.selectionHasChannel = false;
    for (const path of state.hostValues.keys()) {
      if (/mValue\.mSelected$/.test(path)) setHostValue(path, 0);
    }
    state.selectedNode.mOnTitleChange?.(activeDevice, activeMapping, '');
  }

  const api = {
    mDefaults: {
      getAppName: () => 'Cubase',
      getNumberOfInsertEffectSlots: () => 16,
      getNumberOfSendSlots: () => 8,
      getNumberOfQuickControls: () => 8,
      mAppVersion: { getVersionString: () => '13.0.51' },
    },
    makeDeviceDriver() {
      const surface = {
        makeCustomValueVariable: (name) => customVar(name),
        makeBlindPanel: () => ({}),
        makeLabelField: () => ({}),
      };
      const hostAccess = hostNode('host');
      hostAccess.makeDirectAccess = (hostObject) => directAccess(hostObject);
      state.selectedNode = hostAccess.mTrackSelection.mMixerChannel;
      state.focusedQcNode = hostAccess.mFocusedQuickControls;
      const page = {
        mHostAccess: hostAccess,
        makeValueBinding(cv, hostValue) {
          bindHostValue(cv, hostValue);
          return { setValueTakeOverModeJump() {} };
        },
        makeCommandBinding(cv, category, name) {
          cv.bindings.push((v) => {
            if (v <= 0.5) return;
            state.commandsRun.push([category, name]);
            runCommand(category, name);
          });
          return {};
        },
        makeActionBinding(cv, action) {
          cv.bindings.push((v) => {
            if (v <= 0.5) return;
            state.actionsRun.push(action.__path);
            const name = action.__path.split('.').pop();
            const bank = BANK_ACTIONS[name];
            if (bank && action.__path.startsWith('host.mMixConsole.')) moveBank(bank);
            if (name === 'mNextTrack' || name === 'mPrevTrack') {
              // Along the project channels; nothing at the ends.
              const from = state.selectedIndex;
              const to = from < 0 ? 0 : from + (name === 'mNextTrack' ? 1 : -1);
              if (to >= 0 && to < state.project.length && (to !== from || !state.selectionHasChannel)) selectChannel(state.project[to]);
            }
          });
          return {};
        },
        setLabelFieldText() {},
      };
      state.page = page;
      const driver = {
        mPorts: {
          makeMidiInput() {
            const input = {};
            state.midiInput = input;
            return input;
          },
          makeMidiOutput() {
            let dropping = false;
            let delaying = 0;
            return {
              sendMidi(device, bytes) {
                const header = frameHeader(bytes);
                if (header.kind === 2) {
                  // A lost answer: decided on its first chunk, for all of its chunks.
                  if (header.chunk === 0) {
                    dropping = Date.now() < state.stallUntil || state.dropReplies > 0;
                    if (dropping && Date.now() >= state.stallUntil) state.dropReplies--;
                  }
                  if (dropping) return;
                  if (header.chunk === 0 && state.delayNextReplyMs > 0) {
                    delaying = state.delayNextReplyMs;
                    state.delayNextReplyMs = 0;
                  } else if (header.chunk === 0) delaying = 0;
                  if (delaying > 0) {
                    const copy = bytes.slice();
                    setTimeout(() => state.outputListener?.(copy), delaying);
                    return;
                  }
                }
                state.outputListener?.(bytes.slice());
              },
            };
          },
        },
        makeDetectionUnit: () => ({
          detectPortPair: () => ({
            expectInputNameContains() {},
            expectOutputNameContains() {},
            expectInputNameEquals() {},
            expectOutputNameEquals() {},
          }),
        }),
        mSurface: surface,
        mMapping: { makePage: () => page },
      };
      state.deviceDriver = driver;
      return driver;
    },
  };

  function load(scriptPath) {
    const code = readFileSync(scriptPath, 'utf8');
    const sandbox = {
      require: (name) => {
        if (name !== 'midiremote_api_v1') throw new Error(`Unexpected require ${name}`);
        return api;
      },
      console: { log: (m) => state.logs.push(m) },
    };
    vm.runInNewContext(code, sandbox, { filename: scriptPath });
  }

  function activate() {
    state.deviceDriver.mOnActivate?.(activeDevice);
    state.page.mOnActivate(activeDevice, activeMapping);
    // Seed realistic starting values: faders at unity-ish, pan center. A disabled Control Room shows nothing.
    for (const [path, record] of state.hostValues) {
      if (!state.controlRoom && CONTROL_ROOM_PATH.test(path)) {
        state.boundVars.get(path)?.mOnDisplayValueChange?.(activeDevice, '', '');
        continue;
      }
      // A MIDI channel's slot gets no Pre or send values.
      const slot = SLOT_PATH.exec(path);
      if (slot && isMidi(bankChannel(Number(slot[1]))) && MIDI_MISSING.test(slot[2])) continue;
      const v = defaultValue(path);
      for (const listener of record.listeners) listener(v);
    }
    // Cubase names the plugins of the selected track's slots.
    for (const [path, node] of state.pluginSlots) {
      const identity = pluginFor(slotKeyOf(path));
      if (identity) node.mOnChangePluginIdentity(activeDevice, activeMapping, identity.name, identity.vendor ?? '', identity.version ?? '1.0', identity.format ?? 'VST3');
    }
    const titleDelay = state.titleDelayMs;
    state.titleDelayMs = 0;
    showBank();
    state.titleDelayMs = titleDelay;
  }

  /** Title of the channel bank slot `slot` shows now. */
  const slotTitle = (slot) => bankChannel(slot)?.title ?? '';

  /** Loopback transport for CubaseBridge: server bytes go to the script and back. */
  const inbound = new Map();
  const transport = {
    async open(onMessage) {
      state.outputListeners.add(onMessage);
      state.outputListener = (bytes) => setImmediate(() => state.outputListeners.forEach((listener) => listener(bytes)));
    },
    send(bytes) {
      // Whole requests, so they can be logged and dropped.
      const header = frameHeader(bytes);
      let entry = inbound.get(header.id);
      if (!entry || header.chunk === 0) {
        entry = { frames: [], parts: [] };
        inbound.set(header.id, entry);
      }
      entry.frames.push(bytes.slice());
      entry.parts[header.chunk] = String.fromCharCode(...bytes.slice(11, -1));
      if (entry.frames.length < header.count) return;
      inbound.delete(header.id);
      const request = JSON.parse(entry.parts.join(''));
      state.requestLog.push({ id: request.id, method: request.method, params: request.params, session: request.session, at: Date.now() });
      state.onRequest?.(request);
      if (state.dropRequests > 0) {
        state.dropRequests--;
        return;
      }
      for (const frame of entry.frames) setImmediate(() => state.midiInput.mOnSysex(activeDevice, frame));
    },
    close() {},
    describe: () => 'mock loopback',
  };

  /** Requests the server sent with this method, in order. */
  const requests = (method) => state.requestLog.filter((r) => r.method === method);

  /** Cubase naming a bound value: its owner object (objectTitle) and the parameter (valueTitle). A quick control gets assigned. */
  function setValueTitle(path, objectTitle, valueTitle) {
    const cv = state.boundVars.get(path);
    cv?.mOnTitleChange?.(activeDevice, objectTitle, valueTitle);
    if ((QC_PATH.test(path) || FOCUSED_QC_PATH.test(path)) && !state.assignedQc.has(path)) {
      state.assignedQc.add(path);
      const v = state.hostValues.get(path)?.value ?? 0;
      const [display, units] = displayFor(path, v);
      cv?.mOnDisplayValueChange?.(activeDevice, display, units);
    }
  }

  /** Cubase naming the object the focused quick controls follow (the plugin window with the focus). */
  function setFocusedTitle(title) {
    state.focusedQcNode.mOnTitleChange?.(activeDevice, activeMapping, title);
  }

  /** Cubase titling send `send` (0-based) of bank slot `slot` ("1".."8" when empty, "N- Destination" when routed). */
  function setSendTitle(slot, send, title) {
    state.bankChannels[slot].mSends.getByIndex(send).mOnTitleChange?.(activeDevice, activeMapping, title);
  }

  /** Return in the modal "Añadir pista" dialog: Cubase creates the bus. */
  function confirmDialog() {
    const type = state.pendingDialog;
    state.pendingDialog = null;
    if (type) createBus(type);
  }

  /** Transport position in seconds: time(), time(4030) for the left locator, time(4031) for the right one. */
  const time = (tag) => transportTime.get(tag);
  const setTime = (seconds, tag) => transportTime.set(seconds, tag);
  /** Output bus of a project channel by title. */
  const outputOfTitle = (title) => outputOf(state.project.find((c) => c.title === title));

  return {
    state,
    load,
    activate,
    transport,
    selectTrackWithoutMixerChannel,
    slotTitle,
    setHostValue,
    setValueTitle,
    setFocusedTitle,
    setSendTitle,
    requests,
    confirmDialog,
    time,
    setTime,
    outputOf: outputOfTitle,
  };
}
