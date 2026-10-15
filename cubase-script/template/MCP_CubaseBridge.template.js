/**
 * MCP Cubase Bridge - MIDI Remote script for Cubase 13 (MIDI Remote API 1.2).
 *
 * GENERATED FILE: edit cubase-script/template/MCP_CubaseBridge.template.js and run
 * `npm run build:script`. The command catalog is injected at build time.
 *
 * The script exposes Cubase to an external MCP server through two virtual MIDI ports
 * (macOS IAC Driver buses). Requests and responses travel as chunked SysEx frames
 * carrying ASCII-only JSON.
 *
 * Written in ES5 on purpose: the MIDI Remote JavaScript engine does not support ES6+.
 */

var midiremote_api = require('midiremote_api_v1')

//-----------------------------------------------------------------------------
// 0. CONFIGURATION
//-----------------------------------------------------------------------------

var SCRIPT_VERSION = '/*@@VERSION@@*/'

var CONFIG = {
    // IAC bus the MCP server writes to (Cubase input).
    inputPortName: 'MCP to Cubase',
    // IAC bus the MCP server reads from (Cubase output).
    outputPortName: 'MCP from Cubase',
    // Number of mixer channels exposed at once. Use bank navigation for bigger projects.
    bankSize: 48,
    // Sends exposed per bank channel and for the selected track.
    sendSlots: 8,
    // Insert slots exposed for the selected track (Cubase 13 has 16).
    insertSlots: 16,
    // Quick controls exposed for the selected track and the focused quick controls.
    quickControls: 8,
    // Include output busses (Stereo Out) in the mixer bank, needed for master bus work.
    includeOutputChannels: true,
    // Include input channels in the mixer bank.
    includeInputChannels: false,
    // When true, the bank only follows channels visible in the MixConsole (hidden channels drop out and
    // shift the bank indexes). The script always tells Cubase, because Cubase's own default follows visibility.
    followVisibility: false,
    // Create DirectAccess objects (API 1.2+). Disable if Cubase becomes slow.
    enableDirectAccess: true,
    // SysEx payload bytes per chunk.
    chunkSize: 192,
    // Maximum log lines kept in memory.
    maxLogLines: 300
}

var COMMANDS = /*@@COMMANDS@@*/[]

//-----------------------------------------------------------------------------
// 1. DRIVER SETUP
//-----------------------------------------------------------------------------

var deviceDriver = midiremote_api.makeDeviceDriver('MCP', 'CubaseBridge', 'CubSMCP')

var midiInput = deviceDriver.mPorts.makeMidiInput('From MCP')
var midiOutput = deviceDriver.mPorts.makeMidiOutput('To MCP')

var detectionPair = deviceDriver.makeDetectionUnit().detectPortPair(midiInput, midiOutput)
if (detectionPair.expectInputNameContains) {
    detectionPair.expectInputNameContains(CONFIG.inputPortName)
    detectionPair.expectOutputNameContains(CONFIG.outputPortName)
} else {
    detectionPair.expectInputNameEquals(CONFIG.inputPortName)
    detectionPair.expectOutputNameEquals(CONFIG.outputPortName)
}

var surface = deviceDriver.mSurface
var page = deviceDriver.mMapping.makePage('MCP')
var hostAccess = page.mHostAccess

// A small visible panel so the surface is not empty in the MIDI Remote UI.
surface.makeBlindPanel(0, 0, 8, 2)
var statusLabel = surface.makeLabelField(0, 2, 8, 1)

//-----------------------------------------------------------------------------
// 2. RUNTIME STATE
//-----------------------------------------------------------------------------

var RUNTIME = {
    activeDevice: null,
    activeMapping: null,
    activated: false,
    outboundMessageId: 0,
    inbound: {},
    log: [],
    requests: [], // last requests received, to tell a lost request from a lost response
    startedAt: new Date().getTime()
}

var VALUES = {}       // key -> value entry
var VALUE_KEYS = []   // ordered keys
var ACTIONS = {}      // key -> custom value variable bound to a host action
var COMMAND_VARS = [] // index -> { category, name, cv }
var CHANNELS = []     // bank channel metadata
var SELECTED = { title: '', color: null, sendTitles: [] }
var PLUGINS = {}      // slot key -> plugin identity
var DIRECT = {}       // scope -> DirectAccess instance
var TITLES = {}       // generic host object titles (sends, quick controls...)
var CAPABILITIES = {
    directAccess: false,
    insertSlotAccess: false,
    bankActions: [],
    trackActions: [],
    controlRoom: false,
    apiVersion: '1.1',
    // Whether the bank follows MixConsole visibility, as set on the bank zone (null: Cubase has no setting).
    followVisibility: null,
    appName: '',
    appVersion: ''
}
var VAR_COUNTER = 0

function log(message) {
    var line = new Date().toISOString() + ' ' + message
    RUNTIME.log.push(line)
    if (RUNTIME.log.length > CONFIG.maxLogLines) {
        RUNTIME.log.shift()
    }
    console.log('[MCP] ' + message)
}

function safeCall(fn) {
    try {
        return fn()
    } catch (e) {
        return undefined
    }
}

function makeVar(prefix) {
    VAR_COUNTER++
    return surface.makeCustomValueVariable(prefix + '_' + VAR_COUNTER)
}

//-----------------------------------------------------------------------------
// 3. BINDING HELPERS
//-----------------------------------------------------------------------------

/** The level meter of a bank channel (ch.N.meter): not meterMax or meterClip. */
function isMeterKey(key) {
    var at = key.length - '.meter'.length
    return at > 0 && key.indexOf('.meter', at) === at
}

// Meter statistics: the peak, and the level integrated over the time the transport plays (each level counts
// for as long as the meter showed it, not once per callback: Cubase sends more callbacks while the level moves,
// and keeps sending the decay after a stop). METER_ENTRIES are the ch.N.meter entries.
var METER_ENTRIES = []
var TRANSPORT_PLAYING = false

function nowMs() {
    return new Date().getTime()
}

/** Adds the time since the last change, at the level shown during it, while the transport plays. */
function meterFlush(entry, now) {
    if (TRANSPORT_PLAYING && entry.meterSince !== null && typeof entry.value === 'number') {
        var dt = now - entry.meterSince
        if (dt > 0) {
            entry.meterPower += entry.value * entry.value * dt
            entry.meterTime += dt
        }
    }
    entry.meterSince = now
}

function transportChanged(playing) {
    if (playing === TRANSPORT_PLAYING) {
        return
    }
    var now = nowMs()
    for (var i = 0; i < METER_ENTRIES.length; i++) {
        meterFlush(METER_ENTRIES[i], now)
    }
    TRANSPORT_PLAYING = playing
}

function resetMeter(entry) {
    entry.meterMax = 0
    entry.meterSum = 0
    entry.meterCount = 0
    entry.meterPower = 0
    entry.meterTime = 0
    entry.meterSince = nowMs()
}

/**
 * Binds a host value to a custom value variable and keeps its state in VALUES[key].
 */
function bindValue(key, hostValue) {
    if (!hostValue) {
        return null
    }
    var cv = makeVar('v')
    var binding = null
    try {
        binding = page.makeValueBinding(cv, hostValue)
    } catch (e) {
        log('bindValue failed for ' + key + ': ' + e)
        return null
    }
    if (binding && binding.setValueTakeOverModeJump) {
        binding.setValueTakeOverModeJump()
    }
    var entry = {
        key: key,
        cv: cv,
        binding: binding,
        value: null,
        display: null,
        units: null,
        title: null,
        valueTitle: null,
        meterMax: 0,
        meterSum: 0,
        meterCount: 0,
        meterPower: 0,
        meterTime: 0,
        meterSince: null
    }
    var meter = isMeterKey(key)
    var transportStart = key === 'tr.start'
    if (meter) {
        METER_ENTRIES.push(entry)
    }
    cv.mOnProcessValueChange = function (activeDevice, value, diff) {
        if (meter) {
            // The level shown until now counts for the time it was shown.
            meterFlush(entry, nowMs())
        }
        entry.value = value
        if (meter) {
            if (value > entry.meterMax) {
                entry.meterMax = value
            }
            entry.meterSum += value
            entry.meterCount++
        }
        if (transportStart) {
            transportChanged(value > 0.5)
        }
    }
    cv.mOnDisplayValueChange = function (activeDevice, value, units) {
        entry.display = value
        entry.units = units
    }
    cv.mOnTitleChange = function (activeDevice, objectTitle, valueTitle) {
        entry.title = objectTitle
        entry.valueTitle = valueTitle
    }
    VALUES[key] = entry
    VALUE_KEYS.push(key)
    return entry
}

function bindAction(key, hostAction) {
    if (!hostAction) {
        return false
    }
    var cv = makeVar('a')
    try {
        page.makeActionBinding(cv, hostAction)
    } catch (e) {
        log('bindAction failed for ' + key + ': ' + e)
        return false
    }
    ACTIONS[key] = cv
    return true
}

function bindCommand(category, name) {
    var cv = makeVar('c')
    var binding = null
    try {
        binding = page.makeCommandBinding(cv, category, name)
    } catch (e) {
        log('bindCommand failed for ' + category + ' / ' + name + ': ' + e)
    }
    COMMAND_VARS.push({ category: category, name: name, cv: cv, binding: binding })
}

function watchTitle(key, hostObject) {
    if (!hostObject) {
        return
    }
    TITLES[key] = ''
    hostObject.mOnTitleChange = function (activeDevice, activeMapping, title) {
        TITLES[key] = title
    }
}

function watchPluginIdentity(key, slot) {
    if (!slot) {
        return
    }
    PLUGINS[key] = { name: '', vendor: '', version: '', format: '' }
    slot.mOnChangePluginIdentity = function (activeDevice, activeMapping, name, vendor, version, format) {
        PLUGINS[key] = { name: name, vendor: vendor, version: version, format: format }
    }
}

function makeDirect(scope, hostObject) {
    if (!CONFIG.enableDirectAccess || !hostObject || !hostAccess.makeDirectAccess) {
        return
    }
    try {
        DIRECT[scope] = hostAccess.makeDirectAccess(hostObject)
        CAPABILITIES.directAccess = true
    } catch (e) {
        log('makeDirectAccess failed for ' + scope + ': ' + e)
    }
}

/** Binds the plugin-slot style values shared by inserts, strip modules and instruments. */
function bindPluginSlot(prefix, slot) {
    if (!slot) {
        return
    }
    bindValue(prefix + '.on', slot.mOn)
    bindValue(prefix + '.bypass', slot.mBypass)
    bindValue(prefix + '.edit', slot.mEdit)
    bindValue(prefix + '.autoRead', slot.mAutomationRead)
    bindValue(prefix + '.autoWrite', slot.mAutomationWrite)
    watchPluginIdentity(prefix, slot)
    makeDirect(prefix, slot)
}

/** Binds the core fader/state values of a mixer channel (bank channel or selected track). */
function bindChannelCore(prefix, channelValues) {
    bindValue(prefix + '.volume', channelValues.mVolume)
    bindValue(prefix + '.pan', channelValues.mPan)
    bindValue(prefix + '.mute', channelValues.mMute)
    bindValue(prefix + '.solo', channelValues.mSolo)
    bindValue(prefix + '.monitor', channelValues.mMonitorEnable)
    bindValue(prefix + '.record', channelValues.mRecordEnable)
    bindValue(prefix + '.selected', channelValues.mSelected)
    bindValue(prefix + '.editorOpen', channelValues.mEditorOpen)
    bindValue(prefix + '.instrumentOpen', channelValues.mInstrumentOpen)
    bindValue(prefix + '.autoRead', channelValues.mAutomationRead)
    bindValue(prefix + '.autoWrite', channelValues.mAutomationWrite)
    bindValue(prefix + '.meter', channelValues.mVUMeter)
    bindValue(prefix + '.meterMax', channelValues.mVUMeterMax)
    bindValue(prefix + '.meterClip', channelValues.mVUMeterClip)
}

function bindSends(prefix, sendFolder, titleStore) {
    if (!sendFolder) {
        return
    }
    var count = Math.min(CONFIG.sendSlots, safeCall(function () { return sendFolder.getSize() }) || CONFIG.sendSlots)
    for (var s = 0; s < count; s++) {
        bindSendSlot(prefix + '.send.' + s, sendFolder.getByIndex(s), titleStore, s)
    }
}

function bindSendSlot(prefix, slot, titleStore, index) {
    if (!slot) {
        return
    }
    bindValue(prefix + '.level', slot.mLevel)
    bindValue(prefix + '.on', slot.mOn)
    bindValue(prefix + '.prePost', slot.mPrePost)
    slot.mOnTitleChange = function (activeDevice, activeMapping, title) {
        titleStore[index] = title
    }
}

function bindPreFilter(prefix, preFilter) {
    if (!preFilter) {
        return
    }
    bindValue(prefix + '.pre.bypass', preFilter.mBypass)
    bindValue(prefix + '.pre.gain', preFilter.mGain)
    bindValue(prefix + '.pre.phase', preFilter.mPhaseSwitch)
    bindValue(prefix + '.pre.highCutOn', preFilter.mHighCutOn)
    bindValue(prefix + '.pre.highCutFreq', preFilter.mHighCutFreq)
    bindValue(prefix + '.pre.highCutSlope', preFilter.mHighCutSlope)
    bindValue(prefix + '.pre.lowCutOn', preFilter.mLowCutOn)
    bindValue(prefix + '.pre.lowCutFreq', preFilter.mLowCutFreq)
    bindValue(prefix + '.pre.lowCutSlope', preFilter.mLowCutSlope)
}

function bindChannelEQ(prefix, eq) {
    if (!eq) {
        return
    }
    for (var b = 1; b <= 4; b++) {
        var band = eq['mBand' + b]
        if (!band) {
            continue
        }
        var bandPrefix = prefix + '.eq.' + b
        bindValue(bandPrefix + '.on', band.mOn)
        bindValue(bandPrefix + '.gain', band.mGain)
        bindValue(bandPrefix + '.freq', band.mFreq)
        bindValue(bandPrefix + '.q', band.mQ)
        bindValue(bandPrefix + '.type', band.mFilterType)
    }
}

//-----------------------------------------------------------------------------
// 4. HOST MAPPING
//-----------------------------------------------------------------------------

function detectApi() {
    var defaults = midiremote_api.mDefaults
    CAPABILITIES.appName = safeCall(function () { return defaults.getAppName() }) || ''
    if (defaults && defaults.mAppVersion && defaults.mAppVersion.getVersionString) {
        CAPABILITIES.appVersion = safeCall(function () { return defaults.mAppVersion.getVersionString() }) || ''
        CAPABILITIES.apiVersion = '1.2'
    }
    if (hostAccess.makeDirectAccess) {
        CAPABILITIES.apiVersion = '1.2'
    }
    CAPABILITIES.hostInsertSlots = safeCall(function () { return defaults.getNumberOfInsertEffectSlots() })
    CAPABILITIES.hostSendSlots = safeCall(function () { return defaults.getNumberOfSendSlots() })
    CAPABILITIES.hostQuickControls = safeCall(function () { return defaults.getNumberOfQuickControls() })
}

function setupMixerBank() {
    var zone = hostAccess.mMixConsole.makeMixerBankZone('MCP Bank')
    zone.includeAudioChannels()
    zone.includeInstrumentChannels()
    if (zone.includeSamplerChannels) { zone.includeSamplerChannels() }
    zone.includeMIDIChannels()
    zone.includeFXChannels()
    zone.includeGroupChannels()
    zone.includeVCAChannels()
    if (CONFIG.includeOutputChannels) { zone.includeOutputChannels() }
    if (CONFIG.includeInputChannels) { zone.includeInputChannels() }
    if (zone.setFollowVisibility) {
        zone.setFollowVisibility(!!CONFIG.followVisibility)
        CAPABILITIES.followVisibility = !!CONFIG.followVisibility
    }

    for (var i = 0; i < CONFIG.bankSize; i++) {
        setupBankChannel(i, zone.makeMixerBankChannel())
    }

    var actions = zone.mAction || {}
    var names = ['mPrevBank', 'mNextBank', 'mResetBank', 'mShiftLeft', 'mShiftRight']
    var keys = ['bank.prev', 'bank.next', 'bank.reset', 'bank.shiftLeft', 'bank.shiftRight']
    for (var a = 0; a < names.length; a++) {
        if (actions[names[a]] && bindAction(keys[a], actions[names[a]])) {
            CAPABILITIES.bankActions.push(keys[a])
        }
    }
}

/**
 * Bank channel values saved by mix snapshots (see 'snapshot.read'). autoRead is saved to tell which channels
 * follow their automation (the server does not restore it, nor the values automation overrides).
 */
var SNAPSHOT_FIELDS = ['volume', 'pan', 'mute', 'solo', 'autoRead', 'pre.gain', 'pre.phase', 'pre.lowCutOn', 'pre.lowCutFreq']
for (var sf = 0; sf < CONFIG.sendSlots; sf++) {
    SNAPSHOT_FIELDS.push('send.' + sf + '.level', 'send.' + sf + '.on', 'send.' + sf + '.prePost')
}

function setupBankChannel(index, channel) {
    var meta = { index: index, title: '', color: null, active: false, sendTitles: [], channel: channel }
    CHANNELS.push(meta)
    channel.mOnTitleChange = function (activeDevice, activeMapping, title) {
        meta.title = title
    }
    channel.mOnColorChange = function (activeDevice, activeMapping, r, g, b, a, isActive) {
        meta.color = [r, g, b, a]
        meta.active = isActive
    }
    var prefix = 'ch.' + index
    bindChannelCore(prefix, channel.mValue)
    if (channel.mPreFilter) {
        bindValue(prefix + '.pre.gain', channel.mPreFilter.mGain)
        bindValue(prefix + '.pre.phase', channel.mPreFilter.mPhaseSwitch)
        bindValue(prefix + '.pre.lowCutOn', channel.mPreFilter.mLowCutOn)
        bindValue(prefix + '.pre.lowCutFreq', channel.mPreFilter.mLowCutFreq)
    }
    bindSends(prefix, channel.mSends, meta.sendTitles)
}

function setupSelectedTrack() {
    var trackSelection = hostAccess.mTrackSelection
    var sel = trackSelection.mMixerChannel
    sel.mOnTitleChange = function (activeDevice, activeMapping, title) {
        SELECTED.title = title
    }
    sel.mOnColorChange = function (activeDevice, activeMapping, r, g, b, a, isActive) {
        SELECTED.color = [r, g, b, a]
    }

    bindChannelCore('sel', sel.mValue)
    bindPreFilter('sel', sel.mPreFilter)
    bindChannelEQ('sel', sel.mChannelEQ)
    bindSends('sel', sel.mSends, SELECTED.sendTitles)
    makeDirect('selected', sel)

    // Quick controls of the selected track.
    if (sel.mQuickControls) {
        var qcCount = Math.min(CONFIG.quickControls, safeCall(function () { return sel.mQuickControls.getSize() }) || CONFIG.quickControls)
        for (var q = 0; q < qcCount; q++) {
            bindValue('sel.qc.' + q, sel.mQuickControls.getByIndex(q))
        }
    }

    // Instrument slot.
    bindPluginSlot('sel.inst', sel.mInstrumentPluginSlot)

    // Strip modules.
    var effects = sel.mInsertAndStripEffects
    if (effects) {
        var strip = effects.mStripEffects
        var modules = ['Gate', 'Compressor', 'Tools', 'Saturator', 'Limiter']
        if (strip) {
            for (var m = 0; m < modules.length; m++) {
                bindPluginSlot('sel.strip.' + modules[m].toLowerCase(), strip['m' + modules[m]])
            }
        }
        // Insert slots.
        for (var s = 0; s < CONFIG.insertSlots; s++) {
            var viewer = effects.makeInsertEffectViewer('MCP Insert ' + s)
            if (viewer.accessSlotAtIndex) {
                viewer.accessSlotAtIndex(s)
                CAPABILITIES.insertSlotAccess = true
            } else if (s > 0) {
                break
            }
            bindPluginSlot('sel.ins.' + s, viewer)
        }
    }

    var actions = trackSelection.mAction || {}
    if (actions.mNextTrack && bindAction('track.next', actions.mNextTrack)) {
        CAPABILITIES.trackActions.push('track.next')
    }
    if (actions.mPrevTrack && bindAction('track.prev', actions.mPrevTrack)) {
        CAPABILITIES.trackActions.push('track.prev')
    }
}

function setupTransport() {
    var transport = hostAccess.mTransport
    var v = transport.mValue
    bindValue('tr.start', v.mStart)
    bindValue('tr.stop', v.mStop)
    bindValue('tr.record', v.mRecord)
    bindValue('tr.rewind', v.mRewind)
    bindValue('tr.forward', v.mForward)
    bindValue('tr.cycle', v.mCycleActive)
    bindValue('tr.metronome', v.mMetronomeActive)
    bindValue('tr.clickLevel', v.mMetronomeClickLevel)
    makeDirect('transport', transport)
}

function setupFocusedQuickControls() {
    var fqc = hostAccess.mFocusedQuickControls
    if (!fqc) {
        return
    }
    var count = Math.min(CONFIG.quickControls, safeCall(function () { return fqc.getSize() }) || CONFIG.quickControls)
    for (var q = 0; q < count; q++) {
        bindValue('fqc.' + q, fqc.getByIndex(q))
    }
    bindValue('fqc.locked', fqc.mFocusLockedValue)
    watchTitle('fqc', fqc)
}

function setupControlRoom() {
    var cr = hostAccess.mControlRoom
    if (!cr || !cr.mMainChannel) {
        return
    }
    var main = cr.mMainChannel
    bindValue('cr.main.level', main.mLevelValue)
    bindValue('cr.main.mute', main.mMuteValue)
    bindValue('cr.main.dim', main.mDimActiveValue)
    bindValue('cr.main.bypassInserts', main.mBypassInserts)
    bindValue('cr.main.referenceLevelEnabled', main.mReferenceLevelEnabledValue)
    bindValue('cr.main.clickActive', main.mMetronomeClickActiveValue)
    bindValue('cr.main.clickLevel', main.mMetronomeClickLevelValue)
    bindValue('cr.main.listenEnabled', main.mListenEnabledValue)
    bindValue('cr.referenceLevel', cr.mReferenceLevelValue)
    bindValue('cr.talkbackActive', cr.mTalkbackActiveValue)
    makeDirect('controlroom', cr)
    CAPABILITIES.controlRoom = true
}

function setupMouse() {
    var mouse = hostAccess.mMouseCursor
    if (!mouse) {
        return
    }
    bindValue('mouse.value', mouse.mValueUnderMouse)
    bindValue('mouse.locked', mouse.mValueLocked)
}

function setupCommands() {
    for (var i = 0; i < COMMANDS.length; i++) {
        bindCommand(COMMANDS[i][0], COMMANDS[i][1])
    }
}

detectApi()
setupMixerBank()
setupSelectedTrack()
setupTransport()
setupFocusedQuickControls()
setupControlRoom()
setupMouse()
makeDirect('mixconsole', hostAccess.mMixConsole)
setupCommands()

//-----------------------------------------------------------------------------
// 5. LIFECYCLE
//-----------------------------------------------------------------------------

page.mOnActivate = function (activeDevice, activeMapping) {
    RUNTIME.activeDevice = activeDevice
    RUNTIME.activeMapping = activeMapping
    RUNTIME.activated = true
    for (var scope in DIRECT) {
        if (DIRECT.hasOwnProperty(scope)) {
            try {
                DIRECT[scope].activate(activeMapping)
            } catch (e) {
                log('DirectAccess activate failed for ' + scope + ': ' + e)
            }
        }
    }
    log('Page activated. Values: ' + VALUE_KEYS.length + ', commands: ' + COMMAND_VARS.length)
    sendMessage(activeDevice, 3, { event: 'hello', version: SCRIPT_VERSION, capabilities: CAPABILITIES })
}

page.mOnDeactivate = function (activeDevice, activeMapping) {
    for (var scope in DIRECT) {
        if (DIRECT.hasOwnProperty(scope)) {
            safeCall(function () { DIRECT[scope].deactivate(activeMapping) })
        }
    }
    RUNTIME.activated = false
}

deviceDriver.mOnActivate = function (activeDevice) {
    RUNTIME.activeDevice = activeDevice
    log('MCP Cubase Bridge ' + SCRIPT_VERSION + ' activated')
}

//-----------------------------------------------------------------------------
// 6. SYSEX TRANSPORT
//-----------------------------------------------------------------------------

var SYSEX_MANUFACTURER = 0x7d
var SYSEX_TAG = 0x4d
var SYSEX_VERSION = 0x01
var HEADER_LENGTH = 11 // F0 + 10 header bytes

function toAsciiJson(object) {
    var json = JSON.stringify(object)
    return json.replace(/[\u007f-￿]/g, function (c) {
        return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4)
    })
}

function sendMessage(activeDevice, kind, object) {
    if (!activeDevice) {
        return
    }
    var text = toAsciiJson(object)
    var chunkSize = CONFIG.chunkSize
    var chunkCount = Math.max(1, Math.ceil(text.length / chunkSize))
    RUNTIME.outboundMessageId = (RUNTIME.outboundMessageId + 1) % 16384
    var id = RUNTIME.outboundMessageId
    for (var c = 0; c < chunkCount; c++) {
        var bytes = [0xf0, SYSEX_MANUFACTURER, SYSEX_TAG, SYSEX_VERSION, kind,
            (id >> 7) & 0x7f, id & 0x7f,
            (c >> 7) & 0x7f, c & 0x7f,
            (chunkCount >> 7) & 0x7f, chunkCount & 0x7f]
        var start = c * chunkSize
        var end = Math.min(text.length, start + chunkSize)
        for (var i = start; i < end; i++) {
            bytes.push(text.charCodeAt(i) & 0x7f)
        }
        bytes.push(0xf7)
        midiOutput.sendMidi(activeDevice, bytes)
    }
    return chunkCount
}

function messageToArray(message) {
    var bytes = []
    for (var i = 0; i < message.length; i++) {
        bytes.push(message[i])
    }
    return bytes
}

midiInput.mOnSysex = function (activeDevice, message) {
    RUNTIME.activeDevice = activeDevice
    var bytes = messageToArray(message)
    var offset = bytes[0] === 0xf0 ? 1 : 0
    if (bytes[offset] !== SYSEX_MANUFACTURER || bytes[offset + 1] !== SYSEX_TAG) {
        return
    }
    var kind = bytes[offset + 3]
    var id = (bytes[offset + 4] << 7) | bytes[offset + 5]
    var chunkIndex = (bytes[offset + 6] << 7) | bytes[offset + 7]
    var chunkCount = (bytes[offset + 8] << 7) | bytes[offset + 9]
    var end = bytes[bytes.length - 1] === 0xf7 ? bytes.length - 1 : bytes.length
    var text = ''
    for (var i = offset + 10; i < end; i++) {
        text += String.fromCharCode(bytes[i])
    }
    if (kind !== 1) {
        return
    }
    var pending = RUNTIME.inbound[id]
    if (!pending || chunkIndex === 0) {
        pending = { parts: [], received: 0, count: chunkCount }
        RUNTIME.inbound[id] = pending
    }
    if (pending.parts[chunkIndex] === undefined) {
        pending.received++
    }
    pending.parts[chunkIndex] = text
    if (pending.received < pending.count) {
        return
    }
    delete RUNTIME.inbound[id]
    var request = null
    try {
        request = JSON.parse(pending.parts.join(''))
    } catch (e) {
        log('Invalid JSON request: ' + e)
        return
    }
    handleRequest(activeDevice, request)
}

function handleRequest(activeDevice, request) {
    // The session tells server processes apart: each one starts its ids at a random number.
    var response = { id: request.id, session: request.session }
    var record = { id: request.id, session: request.session, method: request.method, receivedAt: new Date().getTime(), chunks: null }
    RUNTIME.requests.push(record)
    if (RUNTIME.requests.length > 50) {
        RUNTIME.requests.shift()
    }
    try {
        var handler = HANDLERS[request.method]
        if (!handler) {
            throw new Error('Unknown method: ' + request.method)
        }
        response.result = handler(request.params || {}, activeDevice)
    } catch (e) {
        response.error = String(e && e.message ? e.message : e)
        log('Request ' + request.method + ' failed: ' + response.error)
    }
    record.chunks = sendMessage(activeDevice, 2, response)
    record.ms = new Date().getTime() - record.receivedAt
}

//-----------------------------------------------------------------------------
// 7. REQUEST HANDLERS
//-----------------------------------------------------------------------------

/**
 * When the selected track has no mixer channel (folder, MIDI, marker track...) Cubase 13 empties the title of
 * the selection object but its sel.* values keep the last mixer channel (their object title still names it),
 * so report its own selected flag and the bank channels that are really selected. uid: unique id of the
 * selected mixer channel, when Cubase gives one.
 */
function selectionInfo() {
    var bankSelected = []
    for (var i = 0; i < CHANNELS.length; i++) {
        var flag = VALUES['ch.' + i + '.selected']
        if (CHANNELS[i].title && flag && flag.value > 0.5) {
            bankSelected.push({ index: i, title: CHANNELS[i].title })
        }
    }
    var selectedFlag = VALUES['sel.selected']
    var mapping = RUNTIME.activeMapping
    var selectionObject = hostAccess.mTrackSelection.mMixerChannel
    // Only for a selection bound to a mixer channel: on an unbound object Cubase 13 crashes.
    var uid = mapping && SELECTED.title && selectionObject.getUniqueIDString
        ? safeCall(function () { return selectionObject.getUniqueIDString(mapping) })
        : undefined
    return {
        title: SELECTED.title,
        uid: uid || null,
        selectedFlag: selectedFlag ? selectedFlag.value : null,
        bankSelected: bankSelected
    }
}

function requireMapping() {
    if (!RUNTIME.activeMapping) {
        throw new Error('Mapping page is not active yet. Open a project in Cubase.')
    }
    return RUNTIME.activeMapping
}

var CHANNEL_KEY = /^ch\.(\d+)\.(.*)$/
var SEND_FIELD = /^send\.(\d+)\./

/** Cubase 13 titles a routed send "N- Destination" and an empty one with its number ("1".."8") or nothing. */
function sendHasDestination(title) {
    return !!title && !/^\s*\d+\s*$/.test(String(title))
}

/**
 * True when a value belongs to no channel. Cubase does not tell a binding that its object went away, so it
 * keeps the last value: an empty bank slot keeps the values of the channel it showed before, a send slot
 * without destination keeps a level, and sel.* keep the last mixer channel when the selected track has none.
 */
function isStaleKey(key) {
    var match = CHANNEL_KEY.exec(key)
    if (match) {
        var meta = CHANNELS[Number(match[1])]
        if (!meta || !meta.title) {
            return true
        }
        var send = SEND_FIELD.exec(match[2])
        return !!send && !sendHasDestination(meta.sendTitles[Number(send[1])])
    }
    if (key.indexOf('sel.') === 0 && key !== 'sel.selected') {
        var flag = VALUES['sel.selected']
        if (flag && typeof flag.value === 'number' && flag.value < 0.5) {
            return true
        }
        var selSend = /^sel\.send\.(\d+)\./.exec(key)
        return !!selSend && !sendHasDestination(SELECTED.sendTitles[Number(selSend[1])])
    }
    return false
}

/** Name of the channel a ch.N.* or sel.* key belongs to ('' for an empty slot), null for other keys. */
function channelOfKey(key) {
    var match = CHANNEL_KEY.exec(key)
    if (match) {
        var meta = CHANNELS[Number(match[1])]
        return meta ? meta.title : ''
    }
    return key.indexOf('sel.') === 0 ? SELECTED.title : null
}

/**
 * v value, d display, u units; unless brief, t the title of the object that owns the parameter (the channel
 * for volume, "Standard Panner" for pan, the send for a send level), n the parameter name and, withChannel,
 * ch the channel the key belongs to. stale marks a value that belongs to no channel (see isStaleKey).
 */
function serializeEntry(entry, brief, withChannel) {
    var out = { v: entry.value, d: entry.display, u: entry.units }
    if (!brief) {
        if (entry.title) {
            out.t = entry.title
        }
        if (entry.valueTitle) {
            out.n = entry.valueTitle
        }
        if (withChannel) {
            var owner = channelOfKey(entry.key)
            if (owner) {
                out.ch = owner
            }
        }
    }
    if (isStaleKey(entry.key)) {
        out.stale = true
    }
    if (isMeterKey(entry.key)) {
        out.max = entry.meterMax
        // Same definition as meters.get: RMS of the level over the time the transport played.
        out.avg = entry.meterTime > 0 ? Math.sqrt(entry.meterPower / entry.meterTime) : null
    }
    return out
}

function collectValues(prefix) {
    var out = {}
    for (var i = 0; i < VALUE_KEYS.length; i++) {
        var key = VALUE_KEYS[i]
        if (!prefix || key.indexOf(prefix) === 0) {
            out[key] = serializeEntry(VALUES[key])
        }
    }
    return out
}

/** Cubase unique id of the channel a bank slot shows ('' or null for an empty slot). */
function channelUid(meta, mapping) {
    // Never ask Cubase for the id of an empty slot: Cubase 13 crashes (strlen on a null string).
    if (!mapping || !meta.title) {
        return null
    }
    return safeCall(function () { return meta.channel.getUniqueIDString(mapping) }) || null
}

function channelSummary(meta) {
    return { index: meta.index, title: meta.title, color: meta.color, active: meta.active, sendTitles: meta.sendTitles }
}

function getEntry(key) {
    var entry = VALUES[key]
    if (!entry) {
        throw new Error('Unknown value key: ' + key)
    }
    return entry
}

/** A normalized value clamped to 0..1. Missing or non-numeric values throw instead of writing NaN. */
function toUnit(value) {
    var number = Number(value)
    if (value === undefined || value === null || value === '' || !isFinite(number)) {
        throw new Error(value === undefined || value === null ? 'Missing value' : 'Invalid value: ' + String(value))
    }
    return Math.max(0, Math.min(1, number))
}

function setEntry(activeDevice, key, value) {
    var entry = getEntry(key)
    var clamped = toUnit(value)
    var slot = CHANNEL_KEY.exec(key)
    if (slot && !(CHANNELS[Number(slot[1])] && CHANNELS[Number(slot[1])].title)) {
        // The slot keeps the values of the channel it showed before: a write would go nowhere or somewhere else.
        throw new Error('Bank slot ' + slot[1] + ' is empty: ' + key + ' belongs to no channel')
    }
    entry.cv.setProcessValue(activeDevice, clamped)
    return clamped
}

function pulse(activeDevice, cv) {
    cv.setProcessValue(activeDevice, 1)
    cv.setProcessValue(activeDevice, 0)
}

function getDirect(scope) {
    var da = DIRECT[scope]
    if (!da) {
        throw new Error('DirectAccess scope not available: ' + scope + '. Known: ' + Object.keys(DIRECT).join(', '))
    }
    var mapping = requireMapping()
    if (da.update) {
        safeCall(function () { da.update(mapping) })
    }
    // A scope aliased to the MixConsole root (controlroom with Control Room disabled) fails before any id is used.
    scopeBaseId(da, mapping, scope)
    return da
}

function daOptional(da, method, args) {
    if (typeof da[method] !== 'function') {
        return undefined
    }
    try {
        return da[method].apply(da, args)
    } catch (e) {
        return undefined
    }
}

/** A DirectAccess count: Cubase 13 answers -1 for an object id it does not know, so negatives count as none. */
function daCount(da, method, args) {
    var count = daOptional(da, method, args)
    return typeof count === 'number' && count > 0 ? count : 0
}

/**
 * Whether an object id exists. Cubase 13 does not throw for an unknown id: it answers -1 for the counts,
 * '' for the title, and its setters do nothing.
 */
function objectExists(da, mapping, objectId) {
    if (typeof objectId !== 'number' || !isFinite(objectId) || objectId < 0) {
        return false
    }
    var params = daOptional(da, 'getNumberOfParameters', [mapping, objectId])
    var children = daOptional(da, 'getNumberOfChildObjects', [mapping, objectId])
    return !(typeof params === 'number' && params < 0) && !(typeof children === 'number' && children < 0)
}

function requireObject(da, mapping, objectId) {
    if (!objectExists(da, mapping, objectId)) {
        throw new Error('DirectAccess object ' + objectId + ' does not exist (object ids change when the project or the selection changes: ' +
            'look it up again with cubase_da_tree or cubase_da_find)')
    }
    return objectId
}

/**
 * A tag the object has. Cubase 13 answers -1 (value) and '-' (title) for an unknown tag and ignores writes to it.
 * Tags outside the indexed list (1024 "Name" of a channel) answer a value >= 0, so they are accepted too.
 */
function requireTag(da, mapping, objectId, tag) {
    if (typeof tag !== 'number' || !isFinite(tag)) {
        throw new Error('Invalid parameter tag: ' + String(tag))
    }
    var value = daOptional(da, 'getParameterProcessValue', [mapping, objectId, tag])
    if (typeof value === 'number' && value >= 0) {
        return tag
    }
    var count = daCount(da, 'getNumberOfParameters', [mapping, objectId])
    for (var i = 0; i < count; i++) {
        if (daOptional(da, 'getParameterTagByIndex', [mapping, objectId, i]) === tag) {
            return tag
        }
    }
    throw new Error('Parameter tag ' + tag + ' does not exist on DirectAccess object ' + objectId +
        ' ("' + (daOptional(da, 'getObjectTitle', [mapping, objectId]) || '') + '"): list its tags with cubase_get_plugin_parameters or cubase_da_get_parameters')
}

/** Tag from a request: an existing tag, or the parameter whose title matches. */
function parameterTag(da, mapping, objectId, params) {
    return params.tag !== undefined && params.tag !== null
        ? requireTag(da, mapping, objectId, params.tag)
        : findParameterTag(da, mapping, objectId, params.title, params.match)
}

/**
 * Base object of a scope. A scope other than mixconsole that answers the MixConsole root is an alias, not
 * its object: with Control Room disabled, the controlroom scope answers the mixer root (and writes there
 * would reach "Initialize mixer" and the first channel).
 */
function scopeBaseId(da, mapping, scope) {
    var baseId = da.getBaseObjectID(mapping)
    if (scope !== 'mixconsole' && typeof baseId === 'number' && baseId >= 0 && DIRECT.mixconsole) {
        var mixRoot = safeCall(function () { return DIRECT.mixconsole.getBaseObjectID(mapping) })
        if (mixRoot === baseId) {
            throw new Error(scope === 'controlroom'
                ? 'Control Room is disabled in Cubase (Studio > Studio Setup > Control Room): its DirectAccess scope points at the MixConsole root instead'
                : 'DirectAccess scope ' + scope + ' points at the MixConsole root right now, not at its own object')
        }
    }
    return baseId
}

/** Insert slots, strip modules and the instrument slot: the plugin hangs below the slot as a child object. */
var SLOT_SCOPE = /^sel\.(ins\.\d+|strip\.[a-z]+|inst)$/

function isSlotScope(scope) {
    return SLOT_SCOPE.test(String(scope || ''))
}

function slotLabel(scope) {
    var insert = /^sel\.ins\.(\d+)$/.exec(scope)
    if (insert) {
        return 'insert slot ' + (Number(insert[1]) + 1)
    }
    if (scope.indexOf('sel.strip.') === 0) {
        return 'strip module ' + scope.slice('sel.strip.'.length)
    }
    return 'instrument slot'
}

/** The plugin object of a slot: the first descendant with parameters (null when there is none). */
function findPluginObject(da, mapping, objectId, depth) {
    if (depth >= 3) {
        return null
    }
    var childCount = daCount(da, 'getNumberOfChildObjects', [mapping, objectId])
    for (var i = 0; i < childCount; i++) {
        var childId = daOptional(da, 'getChildObjectID', [mapping, objectId, i])
        if (typeof childId !== 'number' || childId < 0) {
            continue
        }
        if (daCount(da, 'getNumberOfParameters', [mapping, childId]) > 0) {
            return childId
        }
        var below = findPluginObject(da, mapping, childId, depth + 1)
        if (below !== null) {
            return below
        }
    }
    return null
}

/**
 * Why a slot has no plugin to work on. In Cubase 13 an empty slot, and a plugin that is not installed (it
 * keeps its name, the slot shows "!!! name !!!"), still have the slot object with its own parameters (on,
 * bypass, edit...): without this check reads and writes would land on those.
 */
function noPluginMessage(scope) {
    var identity = PLUGINS[scope]
    var where = slotLabel(scope) + ' of "' + SELECTED.title + '"'
    if (!identity || !identity.name) {
        return scope === 'sel.inst'
            ? '"' + SELECTED.title + '" has no instrument (an audio track, or an empty instrument slot)'
            : 'The ' + where + ' is empty'
    }
    return '"' + identity.name + '" in the ' + where + ' is not loaded (plugin not installed or failed to load): Cubase keeps a placeholder ' +
        'without parameters. cubase_da_get_parameters with resolvePlugin false reaches the slot\'s own controls (on, bypass, edit).'
}

/**
 * Object a request works on, and the scope's base object. With an objectId, that object (it must exist).
 * In slot scopes (sel.ins.N, sel.strip.*, sel.inst) the plugin below the slot, or an error when the slot is
 * empty or its plugin is missing; resolvePlugin false gives the slot itself. In other scopes the base object
 * (the selected channel, not its first child); resolvePlugin true descends to the first child with parameters,
 * as does a base object without parameters.
 */
function resolveObjectId(da, mapping, params) {
    if (params.objectId !== undefined && params.objectId !== null) {
        requireObject(da, mapping, params.objectId)
        return { id: params.objectId, baseId: null }
    }
    var scope = params.scope
    var baseId = scopeBaseId(da, mapping, scope)
    if (typeof baseId !== 'number' || baseId < 0) {
        throw new Error(isSlotScope(scope) ? noPluginMessage(scope) : 'Scope ' + scope + ' has no base object right now (no selection?)')
    }
    if (params.resolvePlugin === false) {
        return { id: baseId, baseId: baseId }
    }
    if (isSlotScope(scope)) {
        var plugin = findPluginObject(da, mapping, baseId, 0)
        if (plugin === null) {
            throw new Error(noPluginMessage(scope))
        }
        return { id: plugin, baseId: baseId }
    }
    if (params.resolvePlugin === true || daCount(da, 'getNumberOfParameters', [mapping, baseId]) === 0) {
        var child = findPluginObject(da, mapping, baseId, 0)
        return { id: child === null ? baseId : child, baseId: baseId }
    }
    return { id: baseId, baseId: baseId }
}

/** uid -> bank index of the channels the bank shows now (to tell which tree node is which bank channel). */
function bankIndexByUid(mapping) {
    var out = {}
    for (var i = 0; i < CHANNELS.length; i++) {
        if (CHANNELS[i].title) {
            var uid = channelUid(CHANNELS[i], mapping)
            if (uid) {
                out[uid] = i
            }
        }
    }
    return out
}

/**
 * mixerChannelIndex is DirectAccess's own numbering (Stereo Out is -1, input channels count): not a bank
 * index. bankIndex is added when the object is a channel the bank shows now (matched by unique id).
 */
function describeObject(da, mapping, objectId, brief, bankUids) {
    var out
    if (brief) {
        // Small answer for exploring the tree: no color, unique name or uid.
        out = {
            id: objectId,
            title: daOptional(da, 'getObjectTitle', [mapping, objectId]),
            typeName: daOptional(da, 'getObjectTypeName', [mapping, objectId]),
            paramCount: daCount(da, 'getNumberOfParameters', [mapping, objectId]),
            mixerChannelIndex: daOptional(da, 'getMixerChannelIndex', [mapping, objectId])
        }
    } else {
        out = {
            id: objectId,
            title: daOptional(da, 'getObjectTitle', [mapping, objectId]),
            uniqueName: daOptional(da, 'getObjectUniqueName', [mapping, objectId]),
            typeName: daOptional(da, 'getObjectTypeName', [mapping, objectId]),
            uid: daOptional(da, 'getObjectUniqueIDString', [mapping, objectId]),
            color: daOptional(da, 'getObjectColor', [mapping, objectId]),
            paramCount: daCount(da, 'getNumberOfParameters', [mapping, objectId]),
            mixerChannelIndex: daOptional(da, 'getMixerChannelIndex', [mapping, objectId]),
            mixerChannelVisible: daOptional(da, 'isMixerChannelVisible', [mapping, objectId])
        }
    }
    if (bankUids && typeof out.mixerChannelIndex === 'number') {
        var uid = brief ? daOptional(da, 'getObjectUniqueIDString', [mapping, objectId]) : out.uid
        if (uid && bankUids.hasOwnProperty(uid)) {
            out.bankIndex = bankUids[uid]
        }
    }
    return out
}

function buildTree(da, mapping, objectId, depth, maxDepth, budget) {
    if (budget.left <= 0) {
        budget.truncated = true
        return null
    }
    budget.left--
    var node = describeObject(da, mapping, objectId, budget.brief, budget.bankUids)
    var childCount = daCount(da, 'getNumberOfChildObjects', [mapping, objectId])
    node.childCount = childCount
    if (depth < maxDepth && childCount > 0) {
        node.children = []
        for (var i = 0; i < childCount; i++) {
            var childId = daOptional(da, 'getChildObjectID', [mapping, objectId, i])
            if (typeof childId !== 'number' || childId < 0) {
                continue
            }
            var child = buildTree(da, mapping, childId, depth + 1, maxDepth, budget)
            if (child) {
                node.children.push(child)
            }
        }
    }
    return node
}

/**
 * Breadth first: the channels (depth 1) are all looked at before anything inside them, so a node budget
 * runs out deep in the tree, not after the first channels. Each visited object costs one node.
 */
function findObjects(da, mapping, rootId, maxDepth, test, maxResults, budget) {
    var results = []
    var queue = [{ id: rootId, depth: 0 }]
    var head = 0
    var bankUids = bankIndexByUid(mapping)
    while (head < queue.length) {
        if (budget.left <= 0) {
            budget.truncated = true
            break
        }
        var item = queue[head++]
        budget.left--
        budget.visited++
        var title = String(daOptional(da, 'getObjectTitle', [mapping, item.id]) || '')
        if (test(title)) {
            if (results.length >= maxResults) {
                budget.maxResultsReached = true
                break
            }
            var found = describeObject(da, mapping, item.id, false, bankUids)
            found.depth = item.depth
            results.push(found)
        }
        if (item.depth >= maxDepth) {
            continue
        }
        var childCount = daCount(da, 'getNumberOfChildObjects', [mapping, item.id])
        for (var i = 0; i < childCount; i++) {
            var childId = daOptional(da, 'getChildObjectID', [mapping, item.id, i])
            if (typeof childId === 'number' && childId >= 0) {
                queue.push({ id: childId, depth: item.depth + 1 })
            }
        }
    }
    return results
}

/** Descendants of an object (itself first), breadth first, up to maxObjects. */
function objectAndDescendants(da, mapping, objectId, maxDepth, maxObjects) {
    var out = []
    var queue = [{ id: objectId, depth: 0 }]
    var head = 0
    while (head < queue.length && out.length < maxObjects) {
        var item = queue[head++]
        out.push(item.id)
        if (item.depth >= maxDepth) {
            continue
        }
        var childCount = daCount(da, 'getNumberOfChildObjects', [mapping, item.id])
        for (var i = 0; i < childCount; i++) {
            var childId = daOptional(da, 'getChildObjectID', [mapping, item.id, i])
            if (typeof childId === 'number' && childId >= 0) {
                queue.push({ id: childId, depth: item.depth + 1 })
            }
        }
    }
    return { ids: out, truncated: head < queue.length }
}

function describeParameter(da, mapping, objectId, tag) {
    return {
        tag: tag,
        title: daOptional(da, 'getParameterTitle', [mapping, objectId, tag, 128]),
        value: daOptional(da, 'getParameterProcessValue', [mapping, objectId, tag]),
        display: daOptional(da, 'getParameterDisplayValue', [mapping, objectId, tag]),
        units: daOptional(da, 'getParameterDisplayUnits', [mapping, objectId, tag]),
        defaultValue: daOptional(da, 'getParameterDefaultProcessValue', [mapping, objectId, tag]),
        valueType: daOptional(da, 'getParameterProcessValueType', [mapping, objectId, tag]),
        automatable: daOptional(da, 'isParameterAutomatable', [mapping, objectId, tag])
    }
}

/** Value and display before a write, so the server can tell a display text Cubase ignored. */
function parameterBefore(da, mapping, objectId, tag) {
    return {
        value: daOptional(da, 'getParameterProcessValue', [mapping, objectId, tag]),
        display: daOptional(da, 'getParameterDisplayValue', [mapping, objectId, tag])
    }
}

/**
 * A title test for a text: contains (the default: the text anywhere in the title), exact (the whole title) or
 * regex (a regular expression); all of them ignore case.
 */
function titleMatcher(text, match) {
    var mode = match || 'contains'
    var needle = String(text)
    if (mode === 'regex') {
        var re = null
        try {
            re = new RegExp(needle, 'i')
        } catch (e) {
            throw new Error('Invalid regular expression "' + needle + '": ' + String(e.message || e))
        }
        return function (title) { return re.test(String(title || '')) }
    }
    var lower = needle.toLowerCase()
    if (mode === 'exact') {
        return function (title) { return String(title || '').toLowerCase() === lower }
    }
    if (mode !== 'contains') {
        throw new Error('Unknown match mode "' + mode + '": use contains, exact or regex')
    }
    return function (title) { return String(title || '').toLowerCase().indexOf(lower) >= 0 }
}

/**
 * Tag of the parameter whose title matches (see titleMatcher). When several match, a title equal to the text
 * wins if it is the only one; otherwise it is an error that lists them (a write must not land on the first one).
 */
function findParameterTag(da, mapping, objectId, title, match) {
    if (title === undefined || title === null || String(title) === '') {
        throw new Error('Give a parameter title or tag')
    }
    var test = titleMatcher(title, match)
    var lower = String(title).toLowerCase()
    var count = daCount(da, 'getNumberOfParameters', [mapping, objectId])
    var hits = []
    var equal = []
    for (var i = 0; i < count; i++) {
        var tag = da.getParameterTagByIndex(mapping, objectId, i)
        var paramTitle = String(daOptional(da, 'getParameterTitle', [mapping, objectId, tag, 128]) || '')
        if (!test(paramTitle)) {
            continue
        }
        hits.push({ tag: tag, title: paramTitle })
        if (paramTitle.toLowerCase() === lower) {
            equal.push(tag)
        }
    }
    if (hits.length === 0) {
        throw new Error('Parameter not found: ' + title + (match && match !== 'contains' ? ' (match ' + match + ')' : ''))
    }
    if (hits.length === 1) {
        return hits[0].tag
    }
    if (equal.length === 1) {
        return equal[0]
    }
    var names = []
    for (var h = 0; h < hits.length && h < 20; h++) {
        names.push('"' + hits[h].title + '" (tag ' + hits[h].tag + ')')
    }
    throw new Error('Parameter "' + title + '" matches ' + hits.length + ' parameters: ' + names.join(', ') + (hits.length > 20 ? ', ...' : '') +
        '. Give the whole title with match "exact", a regex with match "regex", or the tag.')
}

/** Plugin-identity values Cubase reports for a slot, plus whether a plugin object is really there. */
function pluginPresence(scope, mapping) {
    var identity = PLUGINS[scope] || { name: '', vendor: '', version: '', format: '' }
    var missing = null
    if (identity.name && DIRECT[scope] && mapping) {
        missing = safeCall(function () {
            var da = DIRECT[scope]
            if (da.update) {
                da.update(mapping)
            }
            var baseId = da.getBaseObjectID(mapping)
            return typeof baseId !== 'number' || baseId < 0 || findPluginObject(da, mapping, baseId, 0) === null
        })
        if (missing === undefined) {
            missing = null
        }
    }
    return {
        slot: scope,
        name: identity.name,
        vendor: identity.vendor,
        version: identity.version,
        format: identity.format,
        empty: !identity.name,
        missing: identity.name ? missing : false,
        on: VALUES[scope + '.on'] ? VALUES[scope + '.on'].value : null,
        bypass: VALUES[scope + '.bypass'] ? VALUES[scope + '.bypass'].value : null,
        edit: VALUES[scope + '.edit'] ? VALUES[scope + '.edit'].value : null
    }
}

/** Control Room is on when one of its main-channel values has a value and a display (disabled, all are empty). */
function controlRoomActive() {
    if (!CAPABILITIES.controlRoom) {
        return false
    }
    for (var i = 0; i < VALUE_KEYS.length; i++) {
        if (VALUE_KEYS[i].indexOf('cr.main.') === 0) {
            var entry = VALUES[VALUE_KEYS[i]]
            if (entry.value !== null && entry.value !== undefined && entry.display !== null && entry.display !== undefined && entry.display !== '') {
                return true
            }
        }
    }
    return false
}

var HANDLERS = {
    'ping': function (params) {
        return {
            pong: true,
            version: SCRIPT_VERSION,
            activated: RUNTIME.activated,
            uptimeMs: new Date().getTime() - RUNTIME.startedAt,
            startedAt: RUNTIME.startedAt,
            echo: params.echo
        }
    },

    'capabilities': function () {
        var keys = []
        for (var scope in DIRECT) {
            if (DIRECT.hasOwnProperty(scope)) {
                keys.push(scope)
            }
        }
        return {
            capabilities: CAPABILITIES,
            controlRoomActive: controlRoomActive(),
            config: CONFIG,
            valueCount: VALUE_KEYS.length,
            commandCount: COMMAND_VARS.length,
            directScopes: keys,
            actions: Object.keys(ACTIONS)
        }
    },

    'state.channels': function (params) {
        var includeValues = params.includeValues !== false
        var mapping = params.uids === true || params.brief === true ? RUNTIME.activeMapping : null
        var channels = []
        for (var i = 0; i < CHANNELS.length; i++) {
            var meta = CHANNELS[i]
            if (!meta.title && params.includeEmpty !== true) {
                continue
            }
            if (params.brief === true) {
                // Small answer for paging the bank: no colors, send titles or values.
                channels.push({ index: meta.index, title: meta.title, uid: channelUid(meta, mapping) })
                continue
            }
            var summary = channelSummary(meta)
            if (params.uids === true) {
                summary.uid = channelUid(meta, mapping)
            }
            if (includeValues) {
                summary.values = collectValues('ch.' + i + '.')
            }
            channels.push(summary)
        }
        return { bankSize: CONFIG.bankSize, channels: channels }
    },

    // Small answer for polling the selection (state.selected carries the whole channel strip).
    'state.selection': function () {
        return selectionInfo()
    },

    'state.selected': function () {
        var plugins = {}
        for (var key in PLUGINS) {
            if (PLUGINS.hasOwnProperty(key) && key.indexOf('sel.') === 0) {
                plugins[key] = PLUGINS[key]
            }
        }
        var info = selectionInfo()
        return {
            title: info.title,
            uid: info.uid,
            color: SELECTED.color,
            sendTitles: SELECTED.sendTitles,
            selectedFlag: info.selectedFlag,
            bankSelected: info.bankSelected,
            plugins: plugins,
            values: collectValues('sel.')
        }
    },

    'state.transport': function () {
        return { values: collectValues('tr.') }
    },

    // available: Control Room is enabled (Cubase keeps the objects when it is disabled, with empty values).
    'state.controlRoom': function () {
        return { available: controlRoomActive(), values: collectValues('cr.') }
    },

    'state.focusedQuickControls': function () {
        return { title: TITLES.fqc, values: collectValues('fqc.') }
    },

    'state.mouse': function () {
        return { values: collectValues('mouse.') }
    },

    // brief: without the object title, parameter name and channel of each value (they repeat), for reading many keys.
    'value.get': function (params) {
        var out = {}
        var keys = params.keys || []
        for (var i = 0; i < keys.length; i++) {
            out[keys[i]] = VALUES[keys[i]] ? serializeEntry(VALUES[keys[i]], params.brief === true, true) : null
        }
        return out
    },

    'value.list': function (params) {
        var prefix = params.prefix || ''
        var keys = []
        for (var i = 0; i < VALUE_KEYS.length; i++) {
            if (VALUE_KEYS[i].indexOf(prefix) === 0) {
                keys.push(VALUE_KEYS[i])
            }
        }
        return { keys: keys }
    },

    'value.set': function (params, activeDevice) {
        return { key: params.key, value: setEntry(activeDevice, params.key, params.value) }
    },

    'value.setMany': function (params, activeDevice) {
        var results = []
        var items = params.items || []
        for (var i = 0; i < items.length; i++) {
            try {
                results.push({ key: items[i].key, value: setEntry(activeDevice, items[i].key, items[i].value) })
            } catch (e) {
                results.push({ key: items[i].key, error: String(e.message || e) })
            }
        }
        return { results: results }
    },

    'value.pulse': function (params, activeDevice) {
        pulse(activeDevice, getEntry(params.key).cv)
        return { key: params.key }
    },

    'action.run': function (params, activeDevice) {
        var cv = ACTIONS[params.key]
        if (!cv) {
            throw new Error('Unknown action: ' + params.key + '. Known: ' + Object.keys(ACTIONS).join(', '))
        }
        pulse(activeDevice, cv)
        return { key: params.key }
    },

    'command.run': function (params, activeDevice) {
        var entry = null
        if (typeof params.index === 'number') {
            entry = COMMAND_VARS[params.index]
        } else {
            for (var i = 0; i < COMMAND_VARS.length; i++) {
                if (COMMAND_VARS[i].category === params.category && COMMAND_VARS[i].name === params.name) {
                    entry = COMMAND_VARS[i]
                    break
                }
            }
        }
        if (!entry) {
            var label = typeof params.index === 'number'
                ? '#' + params.index
                : JSON.stringify(String(params.category || '')) + ' / ' + JSON.stringify(String(params.name || ''))
            throw new Error('Command not bound in script: ' + label)
        }
        // Cubase gives no feedback for a command binding (MR_CommandBinding has no canPerform): sent, not confirmed.
        pulse(activeDevice, entry.cv)
        return { category: entry.category, name: entry.name, sent: true }
    },

    'command.list': function () {
        var out = []
        for (var i = 0; i < COMMAND_VARS.length; i++) {
            out.push([COMMAND_VARS[i].category, COMMAND_VARS[i].name])
        }
        return { commands: out }
    },

    'meters.reset': function () {
        for (var i = 0; i < METER_ENTRIES.length; i++) {
            resetMeter(METER_ENTRIES[i])
        }
        return { reset: true }
    },

    'meters.get': function () {
        var out = []
        var now = nowMs()
        for (var i = 0; i < CHANNELS.length; i++) {
            var meta = CHANNELS[i]
            if (!meta.title) {
                continue
            }
            var meter = VALUES['ch.' + i + '.meter']
            var meterMax = VALUES['ch.' + i + '.meterMax']
            var clip = VALUES['ch.' + i + '.meterClip']
            if (meter) {
                meterFlush(meter, now)
            }
            out.push({
                index: i,
                title: meta.title,
                current: meter ? meter.value : null,
                peakMax: meter ? meter.meterMax : null,
                // Root mean square of the meter level over the time the transport played (null: it did not play).
                rms: meter && meter.meterTime > 0 ? Math.sqrt(meter.meterPower / meter.meterTime) : null,
                playedMs: meter ? meter.meterTime : 0,
                samples: meter ? meter.meterCount : 0,
                hostMax: meterMax ? meterMax.value : null,
                hostMaxDisplay: meterMax ? meterMax.display : null,
                clipped: clip ? clip.value > 0.5 : null
            })
        }
        return { channels: out }
    },

    // Compact mix state for snapshots: numbers only, in SNAPSHOT_FIELDS order, so a whole bank page
    // fits in a few SysEx chunks (state.channels with values is ~150 KB per page). Sends without destination are null.
    'snapshot.read': function (params) {
        var mapping = requireMapping()
        var from = params.from || 0
        var to = Math.min(CHANNELS.length, from + (params.count || CHANNELS.length))
        var out = []
        for (var i = from; i < to; i++) {
            var meta = CHANNELS[i]
            if (!meta.title) {
                continue
            }
            var values = []
            for (var f = 0; f < SNAPSHOT_FIELDS.length; f++) {
                var entry = VALUES['ch.' + i + '.' + SNAPSHOT_FIELDS[f]]
                var send = SEND_FIELD.exec(SNAPSHOT_FIELDS[f])
                // A send without destination keeps values of no use (or of another channel): not saved, not restored.
                values.push(entry && !(send && !sendHasDestination(meta.sendTitles[Number(send[1])])) ? entry.value : null)
            }
            out.push({
                index: i,
                title: meta.title,
                uid: channelUid(meta, mapping),
                values: values
            })
        }
        return { fields: SNAPSHOT_FIELDS, total: CHANNELS.length, channels: out }
    },

    'channel.uid': function (params) {
        var mapping = requireMapping()
        var meta = CHANNELS[params.index]
        if (!meta) {
            throw new Error('Invalid bank index ' + params.index)
        }
        return {
            index: params.index,
            uid: channelUid(meta, mapping),
            runtimeId: meta.title ? safeCall(function () { return meta.channel.getRuntimeID(mapping) }) : null
        }
    },

    'da.scopes': function () {
        return { scopes: Object.keys(DIRECT) }
    },

    'da.tree': function (params) {
        var da = getDirect(params.scope)
        var mapping = requireMapping()
        var rootId = params.objectId !== undefined && params.objectId !== null
            ? requireObject(da, mapping, params.objectId)
            : scopeBaseId(da, mapping, params.scope)
        if (rootId < 0) {
            return { root: null, note: 'No base object for this scope right now.' }
        }
        // 0 is a valid depth (the object alone): no || defaults here.
        var maxNodes = typeof params.maxNodes === 'number' ? params.maxNodes : 400
        var maxDepth = typeof params.maxDepth === 'number' ? params.maxDepth : 3
        var budget = { left: maxNodes, brief: params.brief === true, truncated: false, bankUids: bankIndexByUid(mapping) }
        return { root: buildTree(da, mapping, rootId, 0, maxDepth, budget), truncated: budget.truncated }
    },

    'da.find': function (params) {
        var scope = params.scope || 'mixconsole'
        var da = getDirect(scope)
        var mapping = requireMapping()
        var rootId = params.objectId !== undefined && params.objectId !== null
            ? requireObject(da, mapping, params.objectId)
            : scopeBaseId(da, mapping, scope)
        if (rootId < 0) {
            return { results: [], truncated: false, visited: 0, note: 'No base object for this scope right now.' }
        }
        var started = new Date().getTime()
        var budget = { left: typeof params.maxNodes === 'number' ? params.maxNodes : 20000, visited: 0, truncated: false, maxResultsReached: false }
        var maxResults = typeof params.maxResults === 'number' ? params.maxResults : 100
        var maxDepth = typeof params.maxDepth === 'number' ? params.maxDepth : 6
        var results = findObjects(da, mapping, rootId, maxDepth, titleMatcher(params.titleContains || '', params.match), maxResults, budget)
        return {
            results: results,
            truncated: budget.truncated,
            maxResultsReached: budget.maxResultsReached,
            visited: budget.visited,
            elapsedMs: new Date().getTime() - started
        }
    },

    // fields: only these keys of each parameter (index, and objectId/objectTitle in a child search, are always kept).
    // tags: just those parameters. filter + match (contains, exact, regex): the matching ones, and matchedTotal.
    'da.params': function (params) {
        var fields = params.fields && params.fields.length ? params.fields : null
        var pick = function (info) {
            if (!fields) {
                return info
            }
            var out = {}
            for (var f = 0; f < fields.length; f++) {
                if (info.hasOwnProperty(fields[f])) {
                    out[fields[f]] = info[fields[f]]
                }
            }
            var always = ['index', 'objectId', 'objectTitle']
            for (var a = 0; a < always.length; a++) {
                if (info.hasOwnProperty(always[a])) {
                    out[always[a]] = info[always[a]]
                }
            }
            return out
        }
        var da = getDirect(params.scope)
        var mapping = requireMapping()
        var resolved = resolveObjectId(da, mapping, params)
        var objectId = resolved.id
        var test = params.filter ? titleMatcher(params.filter, params.match) : null
        var offset = params.offset || 0
        var limit = params.limit || 200
        var list = []
        var base = { objectId: objectId, baseObjectId: resolved.baseId, resolved: resolved.baseId !== null && resolved.baseId !== objectId }
        var count = 0
        if (params.tags && params.tags.length) {
            // Just these parameters, in the order asked: a tag the object does not have is an error.
            count = daCount(da, 'getNumberOfParameters', [mapping, objectId])
            var indexOfTag = {}
            for (var x = 0; x < count; x++) {
                indexOfTag[String(daOptional(da, 'getParameterTagByIndex', [mapping, objectId, x]))] = x
            }
            for (var t = 0; t < params.tags.length; t++) {
                var tagged = describeParameter(da, mapping, objectId, requireTag(da, mapping, objectId, params.tags[t]))
                // A tag outside the indexed list (1024, the channel name) has no index.
                tagged.index = indexOfTag.hasOwnProperty(String(params.tags[t])) ? indexOfTag[String(params.tags[t])] : null
                list.push(pick(tagged))
            }
            base.object = describeObject(da, mapping, objectId)
            base.total = count
            base.parameters = list
            return base
        }
        if (test && params.searchChildren === true) {
            // The filter over the object and its descendants (an EQ gain lives in a child object of the channel).
            var objects = objectAndDescendants(da, mapping, objectId, 3, 400)
            var matched = 0
            for (var o = 0; o < objects.ids.length; o++) {
                var id = objects.ids[o]
                var objectTitle = daOptional(da, 'getObjectTitle', [mapping, id])
                var n = daCount(da, 'getNumberOfParameters', [mapping, id])
                for (var p = 0; p < n; p++) {
                    var childTag = da.getParameterTagByIndex(mapping, id, p)
                    var childTitle = String(daOptional(da, 'getParameterTitle', [mapping, id, childTag, 128]) || '')
                    if (!test(childTitle)) {
                        continue
                    }
                    matched++
                    if (matched > offset && list.length < limit) {
                        var hit = describeParameter(da, mapping, id, childTag)
                        hit.index = p
                        hit.objectId = id
                        hit.objectTitle = objectTitle
                        list.push(pick(hit))
                    }
                }
            }
            base.object = describeObject(da, mapping, objectId)
            base.objectsSearched = objects.ids.length
            base.objectsTruncated = objects.truncated
            base.total = matched
            base.matchedTotal = matched
            base.parameters = list
            return base
        }
        count = daCount(da, 'getNumberOfParameters', [mapping, objectId])
        if (test) {
            // With a filter, offset and limit count the matching parameters; matchedTotal is how many match.
            var matches = 0
            for (var m = 0; m < count; m++) {
                var matchTag = da.getParameterTagByIndex(mapping, objectId, m)
                if (!test(String(daOptional(da, 'getParameterTitle', [mapping, objectId, matchTag, 128]) || ''))) {
                    continue
                }
                matches++
                if (matches > offset && list.length < limit) {
                    var found = describeParameter(da, mapping, objectId, matchTag)
                    found.index = m
                    list.push(pick(found))
                }
            }
            base.matchedTotal = matches
        } else {
            for (var i = offset; i < count && list.length < limit; i++) {
                var info = describeParameter(da, mapping, objectId, da.getParameterTagByIndex(mapping, objectId, i))
                info.index = i
                list.push(pick(info))
            }
        }
        base.object = describeObject(da, mapping, objectId)
        base.total = count
        base.parameters = list
        return base
    },

    // The bank channels of the page shown now in the DirectAccess mixer tree: object id, internal name ("Audio 14",
    // "GroupChannel 3", "OutputChannel"...) and the parameters of `tags` (e.g. 4102, the output), matched by unique id.
    // hidden: the channels of the whole MixConsole that DirectAccess reports hidden (isMixerChannelVisible false);
    // null when this Cubase has no isMixerChannelVisible. Only DirectAccess calls on ids the tree gave: no host getters.
    'mixer.channels': function (params) {
        var da = getDirect('mixconsole')
        var mapping = requireMapping()
        var root = da.getBaseObjectID(mapping)
        var bankUids = bankIndexByUid(mapping)
        var tags = params.tags || []
        var out = []
        var visibility = typeof da.isMixerChannelVisible === 'function'
        var hidden = visibility ? [] : null
        var count = daCount(da, 'getNumberOfChildObjects', [mapping, root])
        for (var i = 0; i < count; i++) {
            var id = daOptional(da, 'getChildObjectID', [mapping, root, i])
            if (typeof id !== 'number' || id < 0) {
                continue
            }
            var uid = daOptional(da, 'getObjectUniqueIDString', [mapping, id])
            if (visibility && uid && daOptional(da, 'isMixerChannelVisible', [mapping, id]) === false) {
                hidden.push({ title: daOptional(da, 'getObjectTitle', [mapping, id]) || '', uid: uid, uniqueName: daOptional(da, 'getObjectUniqueName', [mapping, id]) || null })
            }
            if (!uid || !bankUids.hasOwnProperty(uid)) {
                continue
            }
            var item = {
                index: bankUids[uid],
                uid: uid,
                objectId: id,
                uniqueName: daOptional(da, 'getObjectUniqueName', [mapping, id]),
                typeName: daOptional(da, 'getObjectTypeName', [mapping, id])
            }
            if (tags.length > 0) {
                item.params = {}
                for (var t = 0; t < tags.length; t++) {
                    item.params[tags[t]] = {
                        value: daOptional(da, 'getParameterProcessValue', [mapping, id, tags[t]]),
                        display: daOptional(da, 'getParameterDisplayValue', [mapping, id, tags[t]])
                    }
                }
            }
            out.push(item)
        }
        return { channels: out, hidden: hidden }
    },

    'da.getParam': function (params) {
        var da = getDirect(params.scope)
        var mapping = requireMapping()
        var objectId = resolveObjectId(da, mapping, params).id
        var tag = parameterTag(da, mapping, objectId, params)
        return { objectId: objectId, parameter: describeParameter(da, mapping, objectId, tag) }
    },

    // before: value and display before the write (Cubase ignores a text it does not understand without an error,
    // and some writes, like a rename, leave no step in Cubase's history: before is what to write back).
    'da.setParam': function (params) {
        var da = getDirect(params.scope)
        var mapping = requireMapping()
        var objectId = resolveObjectId(da, mapping, params).id
        var tag = parameterTag(da, mapping, objectId, params)
        var before = parameterBefore(da, mapping, objectId, tag)
        if (params.display !== undefined && params.display !== null) {
            if (typeof da.setParameterDisplayValue !== 'function') {
                throw new Error('setParameterDisplayValue is not available in this Cubase version')
            }
            da.setParameterDisplayValue(mapping, objectId, tag, String(params.display))
        } else {
            da.setParameterProcessValue(mapping, objectId, tag, toUnit(params.value))
        }
        return { objectId: objectId, parameter: describeParameter(da, mapping, objectId, tag), before: before }
    },

    'da.setParams': function (params) {
        var da = getDirect(params.scope)
        var mapping = requireMapping()
        var objectId = resolveObjectId(da, mapping, params).id
        var results = []
        var items = params.items || []
        for (var i = 0; i < items.length; i++) {
            try {
                var tag = parameterTag(da, mapping, objectId, { tag: items[i].tag, title: items[i].title, match: items[i].match || params.match })
                // Value and display before every write: the server tells a write Cubase ignored from one it applied.
                var before = parameterBefore(da, mapping, objectId, tag)
                if (items[i].display !== undefined && items[i].display !== null) {
                    if (typeof da.setParameterDisplayValue !== 'function') {
                        throw new Error('setParameterDisplayValue is not available in this Cubase version')
                    }
                    da.setParameterDisplayValue(mapping, objectId, tag, String(items[i].display))
                } else {
                    da.setParameterProcessValue(mapping, objectId, tag, toUnit(items[i].value))
                }
                var result = describeParameter(da, mapping, objectId, tag)
                result.before = before
                results.push(result)
            } catch (e) {
                results.push({ title: items[i].title, tag: items[i].tag, error: String(e.message || e) })
            }
        }
        return { objectId: objectId, results: results }
    },

    // Every plugin slot of the selected track. vendor is what Cubase reports (for a plugin that is not
    // installed it reports its own name); missing: the slot names a plugin but has no plugin object below it.
    'plugins.selected': function () {
        var mapping = RUNTIME.activeMapping
        var out = []
        for (var key in PLUGINS) {
            if (PLUGINS.hasOwnProperty(key) && key.indexOf('sel.') === 0) {
                out.push(pluginPresence(key, mapping))
            }
        }
        return { track: SELECTED.title, plugins: out }
    },

    'log.get': function (params) {
        var count = params.count || 100
        return { lines: RUNTIME.log.slice(-count) }
    },

    // count: only the last N requests that pass the filters; method: part of the method name; session: one server's requests.
    // kept and oldest* describe the whole history (50 requests), filtered or not.
    'debug.requests': function (params) {
        var all = RUNTIME.requests
        var method = params.method ? String(params.method) : null
        var session = params.session ? String(params.session) : null
        var list = []
        for (var i = 0; i < all.length; i++) {
            if (method !== null && String(all[i].method || '').indexOf(method) < 0) {
                continue
            }
            if (session !== null && all[i].session !== session) {
                continue
            }
            list.push(all[i])
        }
        if (typeof params.count === 'number' && params.count >= 0 && list.length > params.count) {
            list = list.slice(list.length - params.count)
        }
        return {
            requests: list,
            kept: all.length,
            oldestId: all.length > 0 ? all[0].id : null,
            oldestReceivedAt: all.length > 0 ? all[0].receivedAt : null,
            scriptStartedAt: RUNTIME.startedAt
        }
    }
}

if (page.setLabelFieldText) {
    page.setLabelFieldText(statusLabel, 'MCP Bridge ' + SCRIPT_VERSION)
}
log('Script loaded: ' + VALUE_KEYS.length + ' values, ' + COMMAND_VARS.length + ' commands, DirectAccess=' + CAPABILITIES.directAccess)
