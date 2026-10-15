import { z } from 'zod';
import { channelRef, defineTool, prePostWord, sleep, type ToolContext } from './common.js';
import type { ChannelRef, ResolvedChannel, ValueState } from '../cubase/client.js';

/** Raw keys of continuous controls (the ones a search in real units can set). */
const CONTINUOUS_KEY =
  /^(((ch\.\d+|sel)\.(volume|pan|pre\.gain|pre\.(low|high)CutFreq|send\.\d+\.level|eq\.\d+\.(gain|freq|q)|qc\.\d+))|fqc\.\d+|tr\.clickLevel|cr\.(main\.level|main\.clickLevel|referenceLevel))$/;
import { listMidiPorts } from '../bridge/midiBridge.js';

/** A raw key given by channel: "ch[G L Clean].volume" or {channel, field}. */
const keyByChannel = z
  .object({
    channel: channelRef,
    field: z.string().trim().min(1).describe('The part after ch.N., e.g. "volume", "mute", "send.0.level", "pre.gain"'),
  })
  .strict();

const KEYS_HELP =
  'A key is a raw key ("ch.12.volume": bank slot 12 of the page shown now; "sel.eq.1.gain", "tr.cycle"...), a key by channel "ch[<channel>].<field>" ' +
  '(e.g. "ch[G L Clean].volume", "ch[G L#2].mute": the channel is found like any channel reference, on every bank page, and the bank goes back to its page), ' +
  'or {channel, field}.';

type ParsedKey = { kind: 'raw'; label: string; key: string } | { kind: 'channel'; label: string; channel: ChannelRef; field: string };

/** Splits keys by channel from raw keys; "ch.<name>.<field>" (a name where the slot number goes) is an error that says how to write it. */
function parseKey(input: string | z.infer<typeof keyByChannel>): ParsedKey {
  if (typeof input !== 'string') {
    const ref = input.channel;
    const name = typeof ref === 'object' ? `${ref.name}${ref.occurrence ? `#${ref.occurrence}` : ''}` : String(ref);
    return { kind: 'channel', label: `ch[${name}].${input.field}`, channel: ref, field: input.field };
  }
  const key = input.trim();
  const named = /^ch\[(.+)\]\.(.+)$/.exec(key);
  if (named) {
    const channel = named[1].trim();
    if (!channel) throw new Error(`"${input}": the channel between [ ] is empty`);
    return { kind: 'channel', label: key, channel: /^\d+$/.test(channel) ? Number(channel) : channel, field: named[2].trim() };
  }
  if (/^ch\.(?!\d+\.)/.test(key)) {
    const rest = key.slice(3);
    const dot = rest.lastIndexOf('.');
    const hint = dot > 0 ? ` Write "ch[${rest.slice(0, dot)}].${rest.slice(dot + 1)}" (a channel by name; fields with dots such as send.0.level go after the ]) or {channel, field}.` : '';
    throw new Error(`"${input}" is not a raw key: ch. must be followed by a bank slot number (ch.12.volume).${hint}`);
  }
  return { kind: 'raw', label: key, key };
}

const where = (channel: ResolvedChannel) => ({
  title: channel.title,
  index: channel.index,
  ...(channel.page !== undefined ? { page: channel.page } : {}),
  uid: channel.uid,
});

export function registerDiagnosticTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    'cubase_status',
    'Checks the connection with Cubase: MIDI ports, bridge script version and start time, API capabilities (DirectAccess, insert slots, control room: capabilities.controlRoom says the API has it, controlRoomActive that it is enabled in Cubase) and configuration. Run this first. ' +
      'serverSession tells the requests of this server apart in cubase_get_script_log; stalls/resent/lateAnswers count MIDI Remote stalls this server waited out.',
    {},
    async () => {
      const ping = await client.ping();
      const capabilities = await client.capabilities();
      const { bridge } = client;
      const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
      return {
        connection: bridge.describe(),
        script: ping,
        // When the script (re)started, from the ping: its hello only arrives when it activates while this server runs.
        scriptStartedAt: iso(ping.startedAt),
        scriptActivatedDuringSession: iso(bridge.helloAt),
        serverSession: bridge.session,
        lastAnswerAt: iso(bridge.lastAnswerAt),
        ...bridge.stats,
        ...capabilities,
        uiAutomationEnabled: ctx.config.enableUiAutomation,
      };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_list_midi_ports',
    'Lists the MIDI input and output ports visible to the MCP server (useful to debug IAC bus names).',
    {},
    async () => listMidiPorts(),
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_get_script_log',
    'Returns the last log lines of the Cubase bridge script (binding errors, failed requests; count limits them). With requests=true it also lists the requests the script received (it keeps the last 50, from any server process), ' +
      'with how long they took and how many SysEx chunks the answer used; fromThisServer marks the ones this server sent (serverSession; ids start at a random number per server process). ' +
      'requestCount keeps only the last N requests (default 20), method only those whose method contains this text (e.g. "da." or "value.set"), onlyThisServer only the ones of this server ' +
      '(ids repeat across server sessions). A timed-out request id of this server missing from the history never reached Cubase only when the history goes back further than it ' +
      '(oldestId: the oldest request kept, before any filter).',
    {
      count: z.number().int().min(1).max(300).default(80).describe('Log lines'),
      requests: z.boolean().default(false),
      requestCount: z.number().int().min(1).max(50).default(20).describe('With requests: at most this many requests, the most recent'),
      method: z.string().trim().min(1).optional().describe('With requests: only methods containing this text'),
      onlyThisServer: z.boolean().default(false).describe('With requests: only the requests this server process sent'),
    },
    async ({ count, requests, requestCount, method, onlyThisServer }) => {
      const log = await client.call<Record<string, unknown>>('log.get', { count });
      if (!requests) return log;
      const { bridge } = client;
      type Entry = { id: number; method?: string; session?: string; receivedAt?: number };
      const debug = await client.call<{ requests: Entry[]; scriptStartedAt?: number; kept?: number; oldestId?: number | null; oldestReceivedAt?: number | null }>(
        'debug.requests',
        { count: requestCount, ...(method ? { method } : {}), ...(onlyThisServer ? { session: bridge.session } : {}) },
      );
      // Scripts older than the session field: tell by the id range this process used.
      const mine = (r: Entry) => (r.session !== undefined ? r.session === bridge.session : bridge.ownsId(r.id));
      // Older scripts ignore the filters: they are applied here too.
      const list = debug.requests
        .filter((r) => (!method || String(r.method ?? '').includes(method)) && (!onlyThisServer || mine(r)))
        .slice(-requestCount)
        .map((r) => ({ ...r, fromThisServer: mine(r) }));
      const oldestId = debug.oldestId !== undefined ? debug.oldestId : (debug.requests[0]?.id ?? null);
      const oldestAt = debug.oldestReceivedAt !== undefined ? debug.oldestReceivedAt : debug.requests[0]?.receivedAt;
      return {
        ...log,
        serverSession: bridge.session,
        ...(debug.scriptStartedAt !== undefined ? { scriptStartedAt: new Date(debug.scriptStartedAt).toISOString() } : {}),
        ...(debug.kept !== undefined ? { requestsKept: debug.kept } : {}),
        oldestId,
        oldestReceivedAt: oldestAt !== undefined && oldestAt !== null ? new Date(oldestAt).toISOString() : null,
        requests: list,
      };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_reload_script',
    'Asks Cubase to reload the MIDI Remote scripts and checks whether the bridge really restarted. Cubase 13 usually ignores this request when it comes from the script itself: if reloaded is false, ask the user to reload by hand.',
    {},
    async () => {
      const before = await client.ping();
      let commandError: string | null = null;
      await client.runCommand('MIDI Remote', 'Scripting Tools: Reload Scripts').catch((error: Error) => {
        commandError = error.message;
      });
      // A restarted script answers with a new start time (or a lower uptime with older scripts).
      for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(500);
        // Not resent by the bridge: this loop is the retry, and it must stay within a few seconds.
        const after = await client.ping({ retry: false }).catch(() => null);
        if (!after) continue;
        const restarted =
          before.startedAt !== undefined ? after.startedAt !== before.startedAt : after.uptimeMs < before.uptimeMs;
        if (restarted) return { reloaded: true, version: after.version };
      }
      return {
        reloaded: false,
        commandError,
        manualSteps:
          'Reload by hand: in Cubase open the MIDI Remote Manager, open its Scripting Tools menu and choose Reload Scripts. Then run cubase_status to check the script version.',
      };
    },
  );

  defineTool(
    ctx,
    'cubase_list_value_keys',
    'Lists the raw value keys exposed by the bridge (advanced). Prefixes: ch.N. (bank channel), sel. (selected track), tr. (transport), cr. (control room), fqc. (focused quick controls), mouse. ' +
      'Without a prefix it returns a summary (each key pattern with numbers as N, and how many keys follow it) instead of the ~1,800 keys: give a prefix such as "ch.3." or "sel.eq." for the keys themselves.',
    { prefix: z.string().default('') },
    async ({ prefix }) => {
      const { keys } = await client.listKeys(prefix);
      if (prefix) return { count: keys.length, keys };
      const patterns = new Map<string, number>();
      for (const key of keys) {
        const pattern = key.replace(/\.\d+(?=\.|$)/g, '.N');
        patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
      }
      return { count: keys.length, patterns: Object.fromEntries(patterns), note: 'Give a prefix (e.g. "ch.3.", "sel.eq.1.") to list the keys themselves.' };
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_get_raw_values',
    'Reads raw values by key (advanced). Each value has v (normalized 0..1, null before Cubase reported one), d (display text, null or "" when Cubase shows none) and u (units), ' +
      'and when Cubase gives them t (title of the object that owns the parameter: the channel for volume, "Standard Panner" for pan, "Input Filter" for pre.gain, the send ("1- Rev") for send levels), ' +
      'n (the parameter name) and ch (the bank channel or selected track the key belongs to). stale: true marks a value that belongs to no channel: an empty bank slot ' +
      '(it keeps the last channel\'s values), a send slot without destination, or sel.* after the selection moved to a track without mixer channel. ' +
      'Send prePost: v 1 is pre-fader and 0 post-fader (Cubase shows "Activ."/"Desact." or "On"/"Off"), given as prePost "pre"/"post". Switches read 0 or 1. ' +
      `${KEYS_HELP} A key by channel answers under the key as given, with resolvedKey (the ch.N key on the channel's page) and channel; one that cannot be resolved gets { error }. ` +
      'Raw keys the script does not know read null and are listed in unknownKeys.',
    { keys: z.array(z.union([z.string().trim().min(1), keyByChannel])).min(1).max(200).describe(KEYS_HELP) },
    async ({ keys }) => {
      const parsed = keys.map(parseKey);
      const out: Record<string, unknown> = {};
      const raw = parsed.filter((p): p is Extract<ParsedKey, { kind: 'raw' }> => p.kind === 'raw');
      // Raw keys first: ch.N keys address the bank page shown now, before any lookup by name moves it.
      const rawValues = raw.length > 0 ? await client.getValues(raw.map((p) => p.key)) : {};
      const named = parsed.filter((p): p is Extract<ParsedKey, { kind: 'channel' }> => p.kind === 'channel');
      const byChannel = new Map<string, unknown>();
      let bankRestored = true;
      if (named.length > 0) {
        const read = await client.withChannels(
          named.map((p) => p.channel),
          async (channel, i) => {
            const resolvedKey = `ch.${channel.index}.${named[i].field}`;
            const value = (await client.getValues([resolvedKey]))[resolvedKey];
            if (!value) throw new Error(`"${named[i].field}" is not a field of a bank channel (resolved to ${resolvedKey}): list them with cubase_list_value_keys prefix "ch.0."`);
            return { ...value, resolvedKey, channel: where(channel) };
          },
        );
        read.results.forEach((r, i) => byChannel.set(named[i].label, r));
        bankRestored = read.bankRestored;
      }
      const unknown: string[] = [];
      for (const p of parsed) {
        const value = p.kind === 'raw' ? (rawValues[p.key] ?? null) : byChannel.get(p.label);
        if (p.kind === 'raw' && value === null) unknown.push(p.key);
        const key = p.kind === 'raw' ? p.key : ((value as { resolvedKey?: string })?.resolvedKey ?? '');
        if (value && /\.send\.\d+\.prePost$/.test(key)) Object.assign(value, { prePost: prePostWord(value as ValueState) });
        out[p.label] = value;
      }
      if (unknown.length > 0) {
        out.unknownKeys = unknown;
        out.unknownNote = 'These keys are not raw keys of the bridge script (null): list them with cubase_list_value_keys. A channel by name is written ch[<name>].<field>.';
      }
      if (!bankRestored) out.bankWarning = 'The bank could not go back to the page it showed before: bank indexes now point at other channels.';
      return out;
    },
    { readOnly: true },
  );

  defineTool(
    ctx,
    'cubase_set_raw_value',
    'Writes a raw normalized value (0..1) to any key (advanced) and returns what Cubase applied. Prefer the dedicated tools when one exists. ' +
      'Cubase snaps values to its grid: switches only take 0 or 1 (0.5 is read back as 0), and requested / differsFromRequest show when the value differs from the one asked for ' +
      '(snapped, ignored, or not reported yet). The transport time loses its milliseconds this way: write it as display text with cubase_da_set_parameter. ' +
      `${KEYS_HELP} With a channel, the value is written while the bank shows the channel's page (resolvedKey, channel), and the bank goes back after.`,
    { key: z.union([z.string().trim().min(1), keyByChannel]).describe(KEYS_HELP), value: z.number().min(0).max(1) },
    async ({ key, value }) => {
      const parsed = parseKey(key);
      const write = async (rawKey: string) => {
        try {
          return await client.writeAndRead(rawKey, value);
        } catch (error) {
          if (/Unknown value key/.test((error as Error).message)) {
            throw new Error(`${(error as Error).message}: nothing was written. List keys with cubase_list_value_keys; a channel by name is written ch[<name>].<field>.`);
          }
          throw error;
        }
      };
      if (parsed.kind === 'raw') return write(parsed.key);
      return client.withChannel(parsed.channel, async (channel) => {
        const resolvedKey = `ch.${channel.index}.${parsed.field}`;
        return { ...(await write(resolvedKey)), key: parsed.label, resolvedKey, channel: where(channel) };
      });
    },
  );

  defineTool(
    ctx,
    'cubase_seek_raw_value',
    'Sets a continuous raw key to a value in real units (dB, Hz, %, pan) by searching the normalized range against Cubase\'s display (advanced). ' +
      'Only continuous keys: volume, pan, pre.gain, pre.lowCutFreq/highCutFreq, send.N.level, eq.N.gain/freq/q, qc.N (bank channels and sel.), fqc.N, tr.clickLevel and the control room levels. ' +
      'Switches (mute, on, bypass...) are rejected: write them with cubase_set_raw_value as 0 or 1. The search starts from the current value, writes nothing when it already matches, ' +
      'and goes on until Cubase shows the target at its display resolution (or within tolerance when given); Cubase plays the values it passes through.',
    { key: z.string(), target: z.number(), tolerance: z.number().positive().optional() },
    async ({ key, target, tolerance }) => {
      if (!CONTINUOUS_KEY.test(key)) {
        throw new Error(`"${key}" is not a continuous value this search can set: switches and other keys are written with cubase_set_raw_value (0 or 1 for a switch)`);
      }
      return client.seekDisplay(key, target, { tolerance });
    },
  );
}
