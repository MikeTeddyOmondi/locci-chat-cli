import 'dotenv/config';
import express from 'express';
import { streamText, generateText, stepCountIs, type ModelMessage, type ToolSet } from 'ai';
import { resolveModel } from './provider.js';
import { onShutdown, installShutdown } from './shutdown.js';
import {
  connectMcpServers,
  hasMcpConfig,
  mcpConfigPath,
  type McpServerStatus,
} from './mcp.js';

const PORT = Number(process.env.PORT ?? 3000);

// Resolve the provider + model once at startup from PROVIDER / MODEL env vars.
const { provider, modelId, model } = resolveModel();

const app = express();
app.use(express.json());

// --- Optional MCP tools --------------------------------------------------
// Off by default so the harness stays a plain key test. Opt in with either
// MCP_ENABLED=1 or an mcp.json (MCP_CONFIG) next to the project; MCP_ENABLED=0
// forces it off regardless. Servers are declared in the JSON config using the
// same `mcpServers` shape as Claude Desktop / Cursor.
let mcpTools: ToolSet | undefined;
let mcpServers: McpServerStatus[] = [];
const mcpEnabled =
  process.env.MCP_ENABLED === '0' ? false : process.env.MCP_ENABLED === '1' || hasMcpConfig();

if (mcpEnabled) {
  const mcp = await connectMcpServers();
  if (Object.keys(mcp.tools).length > 0) mcpTools = mcp.tools;
  mcpServers = mcp.servers;

  if (mcp.servers.length === 0) {
    console.log(`  · MCP enabled but no servers configured (${mcpConfigPath()})`);
  }
  for (const server of mcp.servers) {
    console.log(
      server.ok
        ? `  ✓ MCP ${server.name} — ${server.toolCount} tool(s)`
        : `  ✗ MCP ${server.name} — failed: ${server.error}`,
    );
    // Registered BEFORE the http server below, so on shutdown the server
    // (registered later) drains first, then each MCP client closes.
    if (server.close) onShutdown(`mcp: ${server.name}`, server.close);
  }
}

/** What both status endpoints report about the local wiring, no API call. */
const wiring = () => ({
  provider,
  model: modelId,
  tools: mcpTools ? Object.keys(mcpTools).length : 0,
  mcp: mcpServers.map(({ name, ok, toolCount, error }) => ({ name, ok, toolCount, error })),
});

/**
 * Cheap metadata for clients (the TUI shows this in its footer). Unlike
 * /status this makes no API call, so it's safe to hit on every launch.
 */
app.get('/info', (_req, res) => {
  res.json(wiring());
});

/**
 * Full status: the local wiring above plus a live key check — a tiny
 * generateText call so you can confirm the selected provider's key + credits
 * actually work, and see the exact error if they don't. Returns 200 with
 * { ok: false, ... } on failure so the CLI can read the body.
 */
app.get('/status', async (_req, res) => {
  try {
    const { text, usage } = await generateText({
      model,
      prompt: 'Reply with exactly: OK',
    });
    res.json({ ok: true, ...wiring(), text, usage });
  } catch (err: any) {
    res.json({
      ok: false,
      ...wiring(),
      statusCode: err?.statusCode,
      error: err?.message ?? String(err),
    });
  }
});

/** Longest tool payload we'll forward to a client, so one huge result can't
 *  swamp the stream. Clients truncate again for display. */
const MAX_PAYLOAD = 4_000;

/**
 * Pull a human-readable message out of whatever the SDK or provider threw.
 * Provider errors arrive as plain objects like { message, type } — String()
 * on those yields "[object Object]", which tells the user nothing.
 */
function describeError(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;

  const e = err as Record<string, any>;
  const message = e.message ?? e.error?.message;
  if (typeof message === 'string' && message) {
    const code = e.code ?? e.error?.code ?? e.type ?? e.error?.type;
    return code ? `${message} (${code})` : message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Flatten an MCP tool result into something readable in a terminal. */
function summarize(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output.slice(0, MAX_PAYLOAD);
  const o = output as { content?: { type?: string; text?: string }[] };
  if (Array.isArray(o.content)) {
    const text = o.content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (text) return text.slice(0, MAX_PAYLOAD);
  }
  try {
    return JSON.stringify(output, null, 2).slice(0, MAX_PAYLOAD);
  } catch {
    return String(output).slice(0, MAX_PAYLOAD);
  }
}

/**
 * Streaming chat. Body: { messages: ModelMessage[], system?: string }.
 *
 * By default streams raw text, exactly as before — the plain CLI reads it chunk
 * by chunk. With `?events=1` it streams NDJSON instead, one JSON object per
 * line, so a client can also show tool activity as it happens:
 *
 *   { "t": "text",       "v": "partial text" }
 *   { "t": "tool",       "id": "…", "name": "read_file", "title": "Read File" }
 *   { "t": "tool-input", "id": "…", "input": { … } }
 *   { "t": "tool-done",  "id": "…", "output": "…" }   // or "error"
 *   { "t": "error",      "v": "…" }
 */
app.post('/chat', async (req, res) => {
  const { messages, system } = req.body as {
    messages?: ModelMessage[];
    system?: string;
  };

  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'Body must be { messages: ModelMessage[] }' });
    return;
  }

  const result = streamText({
    model,
    system,
    messages,
    tools: mcpTools,
    // Turn a single request into a tool-calling loop: the model can call a
    // sandbox tool, get the result, and keep going until it answers (or 8 steps).
    stopWhen: stepCountIs(8),
    onError: ({ error }) => console.error('[stream error]', error),
  });

  if (req.query.events !== '1') {
    result.pipeTextStreamToResponse(res);
    return;
  }

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  const write = (event: Record<string, unknown>) => res.write(`${JSON.stringify(event)}\n`);

  try {
    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          write({ t: 'text', v: part.text });
          break;
        // Fires as soon as the model commits to a tool, before its arguments
        // finish streaming — that's what lets a client say "Using x…" early.
        case 'tool-input-start':
          write({ t: 'tool', id: part.id, name: part.toolName, title: part.title });
          break;
        case 'tool-call':
          write({ t: 'tool-input', id: part.toolCallId, input: part.input });
          break;
        case 'tool-result':
          write({ t: 'tool-done', id: part.toolCallId, output: summarize(part.output) });
          break;
        case 'tool-error':
          write({ t: 'tool-done', id: part.toolCallId, error: describeError(part.error) });
          break;
        case 'error':
          write({ t: 'error', v: describeError(part.error) });
          break;
      }
    }
  } catch (err) {
    // The stream itself failed; tell the client rather than hanging up silently.
    write({ t: 'error', v: describeError(err) });
  }
  res.end();
});

const server = app.listen(PORT, () => {
  console.log(`▶ server on http://localhost:${PORT}  (provider: ${provider}, model: ${modelId})`);
});

// --- Graceful shutdown ---------------------------------------------------
// Cleanups run LIFO on SIGTERM/SIGINT. The MCP client (if enabled) was
// registered above; the http server is registered last so it drains first.
onShutdown('http server', async () => {
  // Streaming responses (/chat) hold connections open, so close idle ones
  // immediately, give active streams a few seconds, then force the rest so
  // server.close() can actually resolve.
  server.closeIdleConnections();
  const forceConns = setTimeout(() => server.closeAllConnections(), 5_000);
  forceConns.unref();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  clearTimeout(forceConns);
});

installShutdown({ timeoutMs: 10_000 });