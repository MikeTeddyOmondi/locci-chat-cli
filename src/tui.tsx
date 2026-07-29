import 'dotenv/config';
import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from './markdown.js';

const API = process.env.API_URL ?? 'http://localhost:3000';
const SYSTEM = process.env.SYSTEM_PROMPT;
const VERSION = '0.1.0'; // keep in sync with the version in cli.ts

// Tokyo-night-ish palette, so the TUI reads the same in light and dark terminals.
const C = {
  accent: '#7aa2f7',
  logo: '#7aa2f7',
  logoDim: '#3b4261',
  user: '#ff9ec8', // pink accent gutter on a human turn
  agent: '#e0af68',
  dim: '#565f89',
  warn: '#f7768e',
  userBlock: '#26222e', // tint behind a human turn
  agentBlock: '#22252e', // neutral grey behind an agent turn
  panel: '#1f2335', // shared background for the composer + its command menu
  selected: '#2f3549', // highlighted row in the command menu
} as const;

/** A tool the model invoked, tracked from "input-start" through to its result. */
type ToolPart = {
  kind: 'tool';
  id: string;
  name: string;
  title?: string;
  input?: unknown;
  output?: string;
  error?: string;
  done: boolean;
  ms?: number;
};
type Part = { kind: 'text'; text: string } | { kind: 'error'; text: string } | ToolPart;

// An assistant turn is an ordered list of parts, so a multi-step answer shows
// text, then the tool it reached for, then more text — in the order it happened.
type Msg = { role: 'user' | 'assistant'; content: string; at: string; parts?: Part[] };

/** The plain text of an assistant turn, which is what we send back as history. */
function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

/** Local wall-clock stamp shown under each turn, e.g. "12:24 PM". */
function stamp(): string {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// --- Splash ---------------------------------------------------------------
// A 5-row block font, only for the letters in "LOCCI CHAT". Each glyph is 5
// wide and joined with a space, so LOCCI is 29 cols and CHAT is 23.
const GLYPHS: Record<string, string[]> = {
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  O: ['█████', '█   █', '█   █', '█   █', '█████'],
  C: ['█████', '█    ', '█    ', '█    ', '█████'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  H: ['█   █', '█   █', '█████', '█   █', '█   █'],
  A: ['█████', '█   █', '█████', '█   █', '█   █'],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
};

/** Render a word as 5 strings of block characters. */
function banner(word: string): string[] {
  return [0, 1, 2, 3, 4].map((row) =>
    word
      .split('')
      .map((ch) => GLYPHS[ch]?.[row] ?? '     ')
      .join(' '),
  );
}

const LOCCI = banner('LOCCI'); // 29 cols
const CHAT = banner('CHAT'); //  23 cols
const WIDE = LOCCI.map((row, i) => `${row}   ${CHAT[i]}`); // one line, 55 cols
// Stacked form: centre the shorter word under the longer one.
const TALL = [...LOCCI, ...CHAT.map((row) => ' '.repeat(3) + row)];

/** Clip to `max` columns so a long string can never wrap and shift the layout. */
function fit(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Commands + shortcuts shown on the splash. Every one of these is wired up. */
const COMMANDS: { name: string; help: string; key: string }[] = [
  { name: '/help', help: 'show this screen', key: 'ctrl+h' },
  { name: '/clear', help: 'clear the conversation', key: 'ctrl+l' },
  { name: '/model', help: 'show provider and model', key: '' },
  { name: '/exit', help: 'quit', key: 'esc' },
];

function Splash({ width, height }: { width: number; height: number }) {
  // Degrade rather than letting anything wrap and shove the layout around:
  // one-line wordmark when it fits, stacked when narrow, plain text when tiny.
  const rows = width >= 62 ? WIDE : width >= 36 ? TALL : null;
  const showLogo = rows !== null && height >= 20;
  // The table needs 10 + 26 + 6 columns plus the root padding.
  const table = width >= 46 ? 'full' : width >= 34 ? 'compact' : 'none';

  return (
    <box
      style={{
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {showLogo ? (
        <box style={{ flexDirection: 'column', flexShrink: 0 }}>
          {rows.map((row, i) => (
            <text key={i} fg={i < 5 || rows === WIDE ? C.logo : C.logoDim}>
              {row}
            </text>
          ))}
        </box>
      ) : (
        <text fg={C.logo}>LOCCI CHAT</text>
      )}

      <box style={{ marginTop: 1, flexShrink: 0 }}>
        <text fg={C.dim}>v{VERSION}</text>
      </box>

      {table === 'full' ? (
        <box style={{ flexDirection: 'column', marginTop: 2, flexShrink: 0 }}>
          {COMMANDS.map((cmd) => (
            <box key={cmd.name} style={{ flexDirection: 'row' }}>
              <text fg={C.accent}>{cmd.name.padEnd(10)}</text>
              <text fg={C.dim}>{cmd.help.padEnd(26)}</text>
              <text fg={C.dim}>{cmd.key}</text>
            </box>
          ))}
        </box>
      ) : table === 'compact' ? (
        <box style={{ marginTop: 2, flexShrink: 0 }}>
          <text fg={C.accent}>{COMMANDS.map((c) => c.name).join(' ')}</text>
        </box>
      ) : null}
    </box>
  );
}

// --- Tool calls -----------------------------------------------------------
/** Compact one-line preview of a tool's arguments, e.g. `path: /tmp, depth: 2`. */
function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
}

/**
 * One tool call in the transcript. Collapsed it's a single muted line; expanded
 * it shows the arguments and result. ctrl+t toggles the focused one.
 */
function ToolRow({
  part,
  focused,
  expanded,
  width,
}: {
  part: ToolPart;
  focused: boolean;
  expanded: boolean;
  width: number;
}) {
  const label = part.title ?? part.name;
  const secs = part.ms != null ? ` · ${(part.ms / 1000).toFixed(1)}s` : '';
  const marker = !part.done ? '⋯' : expanded ? '▾' : '▸';
  const tint = part.error ? C.warn : focused ? C.accent : C.dim;

  // Running: "Using X…". Finished: the marker line, expandable.
  const head = part.done ? `${marker} ${label}${secs}` : `${marker} Using ${label}…`;
  const args = previewInput(part.input);

  const detail = part.error ?? part.output ?? '';
  const lines = detail.split('\n').slice(0, 20);
  const clipped = detail.split('\n').length > lines.length;

  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, marginBottom: 1 }}>
      <box style={{ flexDirection: 'row', flexShrink: 0 }}>
        <text fg={tint}>{focused && part.done ? `${head} ` : head}</text>
        {!expanded && args ? (
          <text fg={C.dim}>{fit(`  ${args}`, Math.max(0, width - head.length - 4))}</text>
        ) : null}
      </box>

      {expanded ? (
        <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 2 }}>
          {args ? <text fg={C.dim}>{fit(`in  ${args}`, width - 4)}</text> : null}
          {lines.map((line, i) => (
            <text key={i} fg={part.error ? C.warn : C.dim}>
              {fit(`${i === 0 ? 'out ' : '    '}${line}`, width - 4)}
            </text>
          ))}
          {clipped ? <text fg={C.dim}>    …</text> : null}
        </box>
      ) : null}
    </box>
  );
}

// --- App ------------------------------------------------------------------
function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();

  const [messages, setMessages] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [footer, setFooter] = useState('connecting…');
  const [showHelp, setShowHelp] = useState(false);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState(0);
  // Accordion state: which tool calls are open, and which one ctrl+t acts on.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toolFocus, setToolFocus] = useState(-1); // -1 = follow the newest

  // Refs mirror state so the async send loop never reads a stale closure.
  const messagesRef = useRef<Msg[]>([]);
  const streamingRef = useRef(false);
  const draftRef = useRef('');
  // The keyboard handler is registered once, so the menu state it reads has to
  // live in refs too (synced from the derived values further down).
  const matchesRef = useRef<typeof COMMANDS>([]);
  const selectedRef = useRef(0);
  const menuOpenRef = useRef(false);
  const toolIdsRef = useRef<string[]>([]);
  const toolFocusRef = useRef(-1);

  // Ask the server what it's running, so the footer isn't guessing from env.
  useEffect(() => {
    let alive = true;
    fetch(`${API}/info`)
      .then((r) => r.json() as Promise<{ provider: string; model: string; tools: number }>)
      .then((d) => {
        if (!alive) return;
        setFooter(`${d.provider} ${d.model}${d.tools ? ` · ${d.tools} tools` : ''}`);
      })
      .catch(() => alive && setFooter('server offline'));
    return () => {
      alive = false;
    };
  }, []);

  const quit = useCallback(() => {
    renderer.destroy();
    process.exit(0);
  }, [renderer]);

  const clear = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
    setShowHelp(false);
    draftRef.current = '';
    setDraft('');
    setInputKey((k) => k + 1);
  }, []);

  /** Put `text` in the composer, remounting <input> so it renders. */
  const setInput = useCallback((text: string) => {
    draftRef.current = text;
    setDraft(text);
    setInputKey((k) => k + 1);
  }, []);

  useKeyboard((key) => {
    if (key.name === 'escape') {
      // Close the command menu first; a second Esc quits.
      if (menuOpenRef.current) setInput('');
      else quit();
    } else if (key.ctrl && key.name === 'l') clear();
    else if (key.ctrl && key.name === 'h') setShowHelp((v) => !v);
    else if (key.ctrl && key.name === 't') {
      // Toggle the focused tool call open/closed.
      const ids = toolIdsRef.current;
      const id = ids[toolFocusRef.current === -1 ? ids.length - 1 : toolFocusRef.current];
      if (id) {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }
    } else if (key.ctrl && (key.name === 'up' || key.name === 'down')) {
      // Walk between tool calls; from -1 (newest) step back through the list.
      const n = toolIdsRef.current.length;
      if (n > 0) {
        setToolFocus((f) => {
          const cur = f === -1 ? n - 1 : f;
          return key.name === 'up' ? (cur - 1 + n) % n : (cur + 1) % n;
        });
      }
    } else if (menuOpenRef.current && (key.name === 'up' || key.name === 'down')) {
      const n = matchesRef.current.length;
      setSelected((s) => (key.name === 'up' ? (s - 1 + n) % n : (s + 1) % n));
    } else if (menuOpenRef.current && key.name === 'tab') {
      const pick = matchesRef.current[selectedRef.current];
      if (pick) setInput(pick.name);
    }
  });

  /** Local slash commands. Returns true when the input was handled here. */
  const runCommand = useCallback(
    (text: string): boolean => {
      switch (text) {
        case '/exit':
        case '/quit':
          quit();
          return true;
        case '/clear':
          clear();
          return true;
        case '/help':
          setShowHelp(true);
          return true;
        case '/model': {
          const note: Msg = { role: 'assistant', content: footer, at: stamp() };
          messagesRef.current = [...messagesRef.current, note];
          setMessages(messagesRef.current);
          setShowHelp(false);
          return true;
        }
        default:
          return false;
      }
    },
    [quit, clear, footer],
  );

  const send = useCallback(async () => {
    let text = draftRef.current.trim();
    if (!text || streamingRef.current) return;

    // Enter on an open command menu runs the highlighted entry, so a partial
    // "/cl" submits /clear rather than being sent to the model.
    if (menuOpenRef.current) {
      text = matchesRef.current[selectedRef.current]?.name ?? text;
    }

    draftRef.current = '';
    setDraft('');
    setInputKey((k) => k + 1); // remount <input> to clear it

    if (runCommand(text)) return;

    streamingRef.current = true;
    setStreaming(true);
    setShowHelp(false);

    // Committed history up to and including this user turn. Only the plain
    // text of past turns goes back to the model — tool parts are display-only.
    const base: Msg[] = [...messagesRef.current, { role: 'user', content: text, at: stamp() }];
    const parts: Part[] = [];
    const started = new Map<string, number>();

    const commit = () => {
      const updated: Msg[] = [
        ...base,
        { role: 'assistant', content: textOf(parts), at: stamp(), parts: [...parts] },
      ];
      messagesRef.current = updated;
      setMessages(updated);
    };
    commit(); // placeholder turn, so the transcript reacts immediately

    const fail = (message: string) => {
      parts.push({ kind: 'text', text: message });
      commit();
    };

    /** Append a text delta, merging into the trailing text part. */
    const addText = (chunk: string) => {
      const last = parts[parts.length - 1];
      if (last?.kind === 'text') last.text += chunk;
      else parts.push({ kind: 'text', text: chunk });
    };

    const tool = (id: string) =>
      parts.find((p): p is ToolPart => p.kind === 'tool' && p.id === id);

    try {
      const res = await fetch(`${API}/chat?events=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: base, system: SYSTEM }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '');
        fail(`⚠️  ${res.status} ${res.statusText} ${errText}`.trim());
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // NDJSON: complete lines only; keep any partial line for the next read.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // a malformed line shouldn't kill the stream
          }

          switch (event.t) {
            case 'text':
              addText(event.v ?? '');
              break;
            case 'tool':
              started.set(event.id, Date.now());
              parts.push({
                kind: 'tool',
                id: event.id,
                name: event.name ?? 'tool',
                title: event.title,
                done: false,
              });
              break;
            case 'tool-input': {
              const t = tool(event.id);
              if (t) t.input = event.input;
              break;
            }
            case 'tool-done': {
              const t = tool(event.id);
              if (t) {
                t.done = true;
                t.output = event.output;
                t.error = event.error;
                t.ms = Date.now() - (started.get(event.id) ?? Date.now());
              }
              break;
            }
            case 'error':
              // Its own part, not body text: a provider failure isn't
              // something the model said, and it must not go back as history.
              parts.push({ kind: 'error', text: event.v ?? 'stream error' });
              break;
          }
        }
        commit();
      }
      commit();
    } catch {
      fail(`⚠️  Server unreachable at ${API}. Start it with: bun run server`);
    } finally {
      streamingRef.current = false;
      setStreaming(false);
    }
  }, [runCommand]);

  const empty = messages.length === 0 || showHelp;

  // Every tool call in the transcript, flattened, so ctrl+t / ctrl+↑↓ can walk
  // them regardless of which turn they belong to.
  const toolIds = useMemo(
    () =>
      messages.flatMap((m) => (m.parts ?? []).filter((p) => p.kind === 'tool').map((p) => p.id)),
    [messages],
  );
  // -1 follows the newest call, so the thing you just watched run is the thing
  // ctrl+t opens.
  const focusId = toolIds[toolFocus === -1 ? toolIds.length - 1 : toolFocus];
  toolIdsRef.current = toolIds;
  toolFocusRef.current = toolFocus;

  const hint = streaming
    ? 'streaming…'
    : toolIds.length > 0
      ? 'enter send · ctrl+t details'
      : 'enter send';

  // Typing "/" opens a completion menu above the composer, filtered by prefix.
  const matches = useMemo(() => {
    if (!draft.startsWith('/') || streaming) return [];
    const q = draft.toLowerCase();
    return COMMANDS.filter((c) => c.name.startsWith(q));
  }, [draft, streaming]);
  const menuOpen = matches.length > 0;
  const index = Math.min(selected, matches.length - 1);

  matchesRef.current = matches;
  selectedRef.current = index;
  menuOpenRef.current = menuOpen;

  return (
    // Every child below is either flexShrink:0 (fixed chrome) or the one
    // flexible pane with minHeight:0. Without that, Yoga squeezes the borders
    // of the fixed rows once the transcript outgrows the viewport — which is
    // what used to make the header drift and collapse into its own text.
    <box style={{ flexDirection: 'column', height: '100%', padding: 1 }}>
      {empty ? (
        <Splash width={width} height={height} />
      ) : (
        <scrollbox
          stickyScroll
          stickyStart="bottom"
          style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, marginBottom: 1 }}
        >
          {messages.map((m, i) => {
            const pending = streaming && i === messages.length - 1 && !m.content;
            const body = m.content || (pending ? '…' : '');

            // User turns sit in a tinted block behind an accent gutter; agent
            // turns run full-width so long answers stay easy to read.
            return m.role === 'user' ? (
              <box
                key={i}
                style={{
                  flexDirection: 'column',
                  flexShrink: 0,
                  marginBottom: 1,
                  border: ['left'],
                  borderStyle: 'heavy',
                  borderColor: C.user,
                  backgroundColor: C.userBlock,
                  paddingLeft: 1,
                  paddingTop: 1,
                  paddingBottom: 1,
                }}
              >
                <text>{body}</text>
                <text fg={C.dim}>you ({m.at})</text>
              </box>
            ) : (
              <box
                key={i}
                style={{
                  flexDirection: 'column',
                  flexShrink: 0,
                  marginBottom: 1,
                  backgroundColor: C.agentBlock,
                  paddingLeft: 1,
                  paddingRight: 1,
                  paddingTop: 1,
                  paddingBottom: 1,
                }}
              >
                {m.parts?.length ? (
                  m.parts.map((part, p) =>
                    part.kind === 'tool' ? (
                      <ToolRow
                        key={part.id}
                        part={part}
                        focused={part.id === focusId}
                        expanded={expanded.has(part.id)}
                        width={width - 4}
                      />
                    ) : part.kind === 'error' ? (
                      <box key={`e-${p}`} style={{ flexDirection: 'row', flexShrink: 0 }}>
                        <text fg={C.warn}>{'✗ '}</text>
                        <text fg={C.warn}>{part.text}</text>
                      </box>
                    ) : (
                      <Markdown key={`t-${p}`} source={part.text} width={width - 4} />
                    ),
                  )
                ) : pending ? (
                  <text fg={C.dim}>…</text>
                ) : (
                  <Markdown source={body} width={width - 4} />
                )}
                <text fg={C.dim}>{`Agent (${m.at})`}</text>
              </box>
            );
          })}
        </scrollbox>
      )}

      {/* Composer: when the command menu is open it shares the input's
          background and borders so the two read as one panel. */}
      <box style={{ flexDirection: 'column', flexShrink: 0, marginTop: 1 }}>
        {menuOpen ? (
          <box
            style={{
              flexDirection: 'column',
              flexShrink: 0,
              border: ['left', 'right', 'top'],
              borderColor: C.accent,
              backgroundColor: C.panel,
              paddingLeft: 1,
              paddingRight: 1,
            }}
          >
            {matches.map((cmd, i) => (
              <box
                key={cmd.name}
                style={{
                  flexDirection: 'row',
                  backgroundColor: i === index ? C.selected : undefined,
                }}
              >
                <text fg={C.accent}>{cmd.name.padEnd(9)}</text>
                <text fg={C.dim}>{fit(cmd.help, Math.max(0, width - 15))}</text>
              </box>
            ))}
          </box>
        ) : null}

        <box
          style={{
            border: menuOpen ? ['left', 'right', 'bottom'] : true,
            borderColor: streaming ? C.dim : C.accent,
            backgroundColor: C.panel,
            // One content row plus its borders — the menu supplies the top one.
            height: menuOpen ? 2 : 3,
            flexShrink: 0,
          }}
        >
          <input
            key={inputKey}
            placeholder={streaming ? 'streaming…' : 'Type a message, Enter to send'}
            onInput={(v: string) => {
              draftRef.current = v;
              setDraft(v);
              setSelected(0);
            }}
            onSubmit={send}
            focused={!streaming}
          />
        </box>
      </box>

      <box
        style={{ flexDirection: 'row', justifyContent: 'space-between', height: 1, flexShrink: 0 }}
      >
        {/* Drop the hint before the two halves can overlap on a narrow terminal. */}
        {width - 2 >= hint.length + footer.length + 2 ? <text fg={C.dim}>{hint}</text> : <text />}
        <text fg={footer === 'server offline' ? C.warn : C.dim}>{fit(footer, width - 4)}</text>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);

// Ctrl+C is handled by exitOnCtrlC; also restore the terminal on SIGTERM
// (e.g. when the parent CLI forwards a signal) so we don't leave it in raw mode.
process.on('SIGTERM', () => {
  try {
    renderer.destroy();
  } catch {
    // ignore — best-effort terminal restore
  }
  process.exit(0);
});
