// import { experimental_createMCPClient as createMCPClient, type ToolSet } from 'ai'; // for AI SDK v5
// import { Experimental_StdioMCPTransport as StdioMCPTransport } from 'ai/mcp-stdio'; // for AI SDK v5
import { createMCPClient } from '@ai-sdk/mcp';
import { ToolSet } from 'ai';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import * as fs from 'node:fs';
import * as path from 'node:path';

// AI SDK v6 note: these moved to a dedicated package —
//   import { createMCPClient } from '@ai-sdk/mcp';
//   import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
// The usage below is otherwise identical.

/** One stdio server entry, using the Claude Desktop / Cursor `mcpServers` shape. */
export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  disabled: boolean;
}

/** Per-server outcome, for boot logging and `mcp list`. */
export interface McpServerStatus {
  name: string;
  ok: boolean;
  toolCount: number;
  error?: string;
  /** Tool keys as merged into the runtime ToolSet (collision prefix applied). */
  toolNames: string[];
  /** Present only when ok — lets server.ts register one handler per server. */
  close?: () => Promise<void>;
}

export interface McpRuntime {
  tools: ToolSet;
  close: () => Promise<void>;
  servers: McpServerStatus[];
}

/** A connected client plus the tools it contributed, before name merging. */
interface ConnectedServer {
  name: string;
  tools: ToolSet;
  close: () => Promise<void>;
}

/** A fresh no-op runtime, for every "MCP is off / unusable" path. */
function emptyRuntime(): McpRuntime {
  return { tools: {}, close: async () => {}, servers: [] };
}

/** Absolute path of the config file — MCP_CONFIG, else ./mcp.json, from cwd. */
export function mcpConfigPath(): string {
  return path.resolve(process.cwd(), process.env.MCP_CONFIG ?? 'mcp.json');
}

/** True when a readable config file exists, used by server.ts to auto-enable MCP. */
export function hasMcpConfig(): boolean {
  return fs.existsSync(mcpConfigPath());
}

/**
 * Read + hand-validate the JSON config. Returns null when the file is missing
 * (a normal case — we fall back to MCP_COMMAND) and an empty map when the file
 * is there but unusable, so a typo degrades to "no tools" rather than a crash.
 *
 * Unknown per-server fields are ignored on purpose, so a config copied straight
 * out of `loccibox mcp config` (or Claude Desktop) keeps working as the schema
 * grows.
 */
export function loadMcpConfig(): Record<string, McpServerConfig> | null {
  const file = mcpConfigPath();
  if (!fs.existsSync(file)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`⚠️  MCP config ${file} is not valid JSON: ${(err as Error).message}`);
    console.error('   Continuing without MCP tools.');
    return {};
  }

  const servers = (raw as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    console.error(`⚠️  MCP config ${file} has no "mcpServers" object.`);
    console.error('   Continuing without MCP tools.');
    return {};
  }

  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const entry = value as Partial<McpServerConfig> | null;
    if (!entry || typeof entry !== 'object' || typeof entry.command !== 'string' || !entry.command) {
      console.error(`⚠️  MCP server "${name}" skipped — missing a string "command".`);
      continue;
    }

    const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : [];

    let env: Record<string, string> | undefined;
    if (entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)) {
      env = {};
      for (const [key, val] of Object.entries(entry.env)) {
        if (typeof val === 'string') env[key] = val;
      }
    }

    out[name] = { command: entry.command, args, env, disabled: entry.disabled === true };
  }
  return out;
}

/** Connect one server. Throws on failure; the caller records it per-server. */
async function connectOne(name: string, config: McpServerConfig): Promise<ConnectedServer> {
  const client = await createMCPClient({
    transport: new StdioMCPTransport({
      command: config.command,
      args: config.args,
      // Server-specific vars win over the ambient environment.
      env: config.env ? { ...(process.env as Record<string, string>), ...config.env } : undefined,
    }),
  });
  const tools = await client.tools();
  return { name, tools, close: () => client.close() };
}

/**
 * Merge every server's tools into one ToolSet. Tool names that appear on more
 * than one server get prefixed with `${serverName}_`; unique names are left
 * alone so existing prompts keep working.
 */
function mergeTools(connected: ConnectedServer[]): {
  tools: ToolSet;
  keysByServer: Map<string, string[]>;
} {
  const seen = new Map<string, number>();
  for (const server of connected) {
    for (const toolName of Object.keys(server.tools)) {
      seen.set(toolName, (seen.get(toolName) ?? 0) + 1);
    }
  }

  const collisions = [...seen].filter(([, count]) => count > 1).map(([toolName]) => toolName);
  if (collisions.length > 0) {
    console.log(
      `  ↔ MCP tool name collision on ${collisions.length} tool(s) — prefixing with the server name: ${collisions.join(', ')}`,
    );
  }

  const tools: ToolSet = {};
  const keysByServer = new Map<string, string[]>();
  for (const server of connected) {
    const keys: string[] = [];
    for (const [toolName, tool] of Object.entries(server.tools)) {
      const key = (seen.get(toolName) ?? 0) > 1 ? `${server.name}_${toolName}` : toolName;
      tools[key] = tool;
      keys.push(key);
    }
    keysByServer.set(server.name, keys);
  }
  return { tools, keysByServer };
}

/**
 * Connect to every enabled MCP server and return the merged tools plus a
 * close() per server for the shutdown registry.
 *
 * Servers come from the JSON config (MCP_CONFIG, default ./mcp.json). With no
 * config file — or a config with zero enabled servers — we fall back to the
 * original single-server behaviour via MCP_COMMAND / MCP_ARGS. With neither,
 * the runtime is empty and the harness still runs as a plain key test.
 *
 * Never throws: a server that can't start is recorded with ok:false and the
 * others carry on.
 *
 * To expose a server over HTTP later, swap StdioMCPTransport for
 *   { type: 'http', url, headers }
 * — everything downstream (tools, close) stays the same.
 */
export async function connectMcpServers(): Promise<McpRuntime> {
  const configured = loadMcpConfig();
  let entries = Object.entries(configured ?? {}).filter(([, c]) => !c.disabled);

  if (entries.length === 0) {
    // No usable config — fall back to the single-server env vars.
    const command = process.env.MCP_COMMAND;
    if (!command) return emptyRuntime();
    const args = (process.env.MCP_ARGS ?? 'mcp start').split(' ').filter(Boolean);
    entries = [['loccibox', { command, args, disabled: false }]];
  }

  const results = await Promise.allSettled(entries.map(([name, c]) => connectOne(name, c)));

  const connected: ConnectedServer[] = [];
  const failed: McpServerStatus[] = [];
  results.forEach((result, i) => {
    const [name, config] = entries[i]!;
    if (result.status === 'fulfilled') {
      connected.push(result.value);
    } else {
      const error = (result.reason as Error)?.message ?? String(result.reason);
      console.error(
        `⚠️  MCP server "${name}" (${config.command} ${config.args.join(' ')}) failed to start: ${error}`,
      );
      failed.push({ name, ok: false, toolCount: 0, toolNames: [], error });
    }
  });

  // Merge after the fact, so collisions are resolved against the servers that
  // actually came up rather than the ones we hoped for.
  const { tools, keysByServer } = mergeTools(connected);

  // Report in config order, so the boot log matches the file the user edited.
  const byName = new Map<string, McpServerStatus>();
  for (const server of connected) {
    const toolNames = keysByServer.get(server.name) ?? [];
    byName.set(server.name, {
      name: server.name,
      ok: true,
      toolCount: toolNames.length,
      toolNames,
      close: server.close,
    });
  }
  for (const status of failed) byName.set(status.name, status);
  const servers = entries.map(([name]) => byName.get(name)!).filter(Boolean);

  return {
    tools,
    servers,
    // Closing every client here too, so a runtime used outside the shutdown
    // registry (e.g. `mcp list`) can tear itself down in one call. allSettled
    // so one hanging client doesn't strand the rest.
    close: async () => {
      await Promise.allSettled(connected.map((s) => s.close()));
    },
  };
}
