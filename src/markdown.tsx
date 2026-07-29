import { markdownToMdast } from 'satteri';
import { useMemo, type ReactNode } from 'react';

// Models answer in Markdown, so parse it with satteri and render the mdast
// straight into OpenTUI's inline elements (<b>, <i>, <span>). We deliberately
// stop at mdast rather than going through markdownToHtml — there's no HTML to
// re-parse, and the AST maps 1:1 onto terminal styling.

const MD = {
  heading: '#7aa2f7',
  rule: '#3b4261',
  code: '#e0af68',
  codeBg: '#1a1b26',
  link: '#7dcfff',
  bullet: '#7aa2f7',
  dim: '#565f89',
  quote: '#9d7cd8',
} as const;

/** mdast nodes are structurally simple; we only read what we render. */
type Node = {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  lang?: string | null;
  url?: string;
  checked?: boolean | null;
  children?: Node[];
};

/** Flatten a node to plain text — used for table column widths. */
function plain(node: Node): string {
  if (node.value) return node.value;
  return (node.children ?? []).map(plain).join('');
}

// --- Inline ---------------------------------------------------------------
function inline(nodes: Node[], key = 'i'): ReactNode[] {
  return nodes.map((node, i) => {
    const k = `${key}-${i}`;
    const kids = node.children ?? [];
    switch (node.type) {
      case 'text':
        return node.value ?? '';
      case 'strong':
        return <b key={k}>{inline(kids, k)}</b>;
      case 'emphasis':
        return <i key={k}>{inline(kids, k)}</i>;
      case 'delete':
        return (
          <span key={k} fg={MD.dim}>
            {inline(kids, k)}
          </span>
        );
      case 'inlineCode':
        return (
          <span key={k} fg={MD.code} bg={MD.codeBg}>
            {node.value ?? ''}
          </span>
        );
      case 'link':
        return (
          <u key={k} fg={MD.link}>
            {kids.length ? inline(kids, k) : (node.url ?? '')}
          </u>
        );
      case 'image':
        return (
          <span key={k} fg={MD.dim}>
            {`[image: ${plain(node) || node.url || ''}]`}
          </span>
        );
      case 'break':
        return '\n';
      default:
        return kids.length ? inline(kids, k) : (node.value ?? '');
    }
  });
}

// --- Blocks ---------------------------------------------------------------
function CodeBlock({ node }: { node: Node }) {
  const lines = (node.value ?? '').split('\n');
  return (
    <box
      style={{
        flexDirection: 'column',
        flexShrink: 0,
        marginTop: 1,
        marginBottom: 1,
        backgroundColor: MD.codeBg,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {node.lang ? <text fg={MD.dim}>{node.lang}</text> : null}
      {lines.map((line, i) => (
        <text key={i} fg={MD.code}>
          {line}
        </text>
      ))}
    </box>
  );
}

function Table({ node, width }: { node: Node; width: number }) {
  const rows = (node.children ?? []).map((row) => (row.children ?? []).map(plain));
  const cols = Math.max(0, ...rows.map((r) => r.length));
  // Size each column to its widest cell, then cap so a wide table still fits.
  const budget = Math.max(8, width - 2);
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.min(
      Math.max(...rows.map((r) => (r[c] ?? '').length), 1),
      Math.max(3, Math.floor(budget / Math.max(1, cols)) - 3),
    ),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, c) => {
        const w = widths[c] ?? 0;
        return (cell.length > w ? `${cell.slice(0, Math.max(0, w - 1))}…` : cell).padEnd(w);
      })
      .join('  ');

  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, marginTop: 1, marginBottom: 1 }}>
      {rows.map((cells, r) =>
        r === 0 ? (
          <box key={r} style={{ flexDirection: 'column' }}>
            <text fg={MD.heading}>{line(cells)}</text>
            <text fg={MD.rule}>{'─'.repeat(Math.min(budget, line(cells).length))}</text>
          </box>
        ) : (
          <text key={r}>{line(cells)}</text>
        ),
      )}
    </box>
  );
}

function blocks(nodes: Node[], width: number, key = 'b'): ReactNode[] {
  return nodes.map((node, i) => {
    const k = `${key}-${i}`;
    const kids = node.children ?? [];
    // Blocks are separated by a blank line, but the last one doesn't get a
    // trailing gap — otherwise every quote and list ends in dead space.
    const gap = i === nodes.length - 1 ? 0 : 1;

    switch (node.type) {
      case 'paragraph':
        return (
          <box key={k} style={{ flexShrink: 0, marginBottom: gap }}>
            <text>{inline(kids, k)}</text>
          </box>
        );

      case 'heading':
        return (
          <box key={k} style={{ flexShrink: 0, marginTop: i === 0 ? 0 : 1, marginBottom: gap }}>
            <text fg={MD.heading}>
              <b>{inline(kids, k)}</b>
            </text>
          </box>
        );

      case 'code':
        return <CodeBlock key={k} node={node} />;

      case 'thematicBreak':
        return (
          <text key={k} fg={MD.rule}>
            {'─'.repeat(Math.max(4, width - 2))}
          </text>
        );

      case 'blockquote':
        return (
          <box
            key={k}
            style={{
              flexDirection: 'column',
              flexShrink: 0,
              marginBottom: gap,
              border: ['left'],
              borderColor: MD.quote,
              paddingLeft: 1,
            }}
          >
            {blocks(kids, width - 2, k)}
          </box>
        );

      case 'list': {
        const start = node.start ?? 1;
        return (
          <box key={k} style={{ flexDirection: 'column', flexShrink: 0, marginBottom: gap }}>
            {kids.map((item, j) => {
              const marker = node.ordered ? `${start + j}.` : '•';
              const check =
                item.checked === true ? '[x] ' : item.checked === false ? '[ ] ' : '';
              // A listItem's first paragraph goes on the marker line; anything
              // after it (nested lists, extra paragraphs) is indented below.
              const [head, ...rest] = item.children ?? [];
              return (
                <box key={`${k}-${j}`} style={{ flexDirection: 'column', flexShrink: 0 }}>
                  <box style={{ flexDirection: 'row', flexShrink: 0 }}>
                    <text fg={MD.bullet}>{`${marker} `}</text>
                    <text>
                      {check}
                      {head ? (head.type === 'paragraph' ? inline(head.children ?? [], k) : plain(head)) : ''}
                    </text>
                  </box>
                  {rest.length ? (
                    <box style={{ flexDirection: 'column', paddingLeft: 2, flexShrink: 0 }}>
                      {blocks(rest, width - 2, `${k}-${j}`)}
                    </box>
                  ) : null}
                </box>
              );
            })}
          </box>
        );
      }

      case 'table':
        return <Table key={k} node={node} width={width} />;

      case 'html':
        return (
          <text key={k} fg={MD.dim}>
            {node.value ?? ''}
          </text>
        );

      default:
        return kids.length ? (
          <box key={k} style={{ flexDirection: 'column', flexShrink: 0 }}>
            {blocks(kids, width, k)}
          </box>
        ) : node.value ? (
          <text key={k}>{node.value}</text>
        ) : null;
    }
  });
}

/**
 * Render a Markdown string as styled terminal output. Parsing is memoised on
 * the source, so a streaming answer only re-parses when a chunk lands, and any
 * parse failure degrades to plain text rather than taking the TUI down.
 */
export function Markdown({ source, width }: { source: string; width: number }) {
  const tree = useMemo(() => {
    try {
      return markdownToMdast(source, { features: { gfm: true } }) as unknown as Node;
    } catch {
      return null;
    }
  }, [source]);

  if (!tree) return <text>{source}</text>;

  return (
    <box style={{ flexDirection: 'column', flexShrink: 0 }}>
      {blocks(tree.children ?? [], width)}
    </box>
  );
}
