#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const API = process.env.API_URL ?? 'http://localhost:3939';

type Msg = { role: 'user' | 'assistant'; content: string };

const program = new Command();
program
  .name('locci-chat')
  .description('Tiny Claude chat CLI — talks to the local Express + AI SDK server')
  .version('0.1.0');

program
  .command('status')
  .alias('verify') // the command was called `verify` before it grew MCP reporting
  .description("Show provider, model and MCP servers, and check the server's API key")
  .action(async () => {
    let res: Response;
    try {
      res = await fetch(`${API}/status`);
    } catch (err) {
      console.error(`❌ Could not reach server at ${API}. Start it with: npm run server`);
      console.error(`   ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const data = (await res.json()) as any;

    console.log(`   provider: ${data.provider}`);
    console.log(`   model:    ${data.model}`);

    const mcp = (data.mcp ?? []) as { name: string; ok: boolean; toolCount: number; error?: string }[];
    if (mcp.length === 0) {
      console.log('   mcp:      none configured');
    } else {
      for (const [i, server] of mcp.entries()) {
        const label = i === 0 ? '   mcp:     ' : '            ';
        console.log(
          server.ok
            ? `${label} ✓ ${server.name} — ${server.toolCount} tool(s)`
            : `${label} ✗ ${server.name} — ${server.error}`,
        );
      }
      console.log(`   tools:    ${data.tools} merged`);
    }

    if (data.ok) {
      console.log(`✅ API key works.  reply: ${JSON.stringify(data.text)}`);
      if (data.usage) console.log('   usage:', data.usage);
    } else {
      console.error(`❌ Key check failed${data.statusCode ? ` (status ${data.statusCode})` : ''}`);
      console.error(`   ${data.error}`);
      console.error('   → Likely an invalid key or no API credits on the Console org.');
      process.exitCode = 1;
    }
  });

program
  .command('chat')
  .description('Interactive streaming chat, Claude-Code style')
  .option('-s, --system <prompt>', 'system prompt')
  .action(async (opts: { system?: string }) => {
    const rl = readline.createInterface({ input, output });
    const messages: Msg[] = [];

    // Ctrl+C has to unwind three things: the in-flight request, the readline
    // interface (which owns raw mode), and the prompt line we're sitting on.
    // Without this the process dies mid-stream and leaves the terminal dirty.
    let stream: AbortController | null = null;
    const session = new AbortController();
    let closing = false;

    const shutdown = () => {
      if (closing) process.exit(130); // impatient second Ctrl+C
      closing = true;
      stream?.abort();
      // A pending rl.question() never settles once the interface closes, so
      // abort it explicitly — otherwise cleanup below is simply skipped.
      session.abort();
      output.write('\n');
      rl.close();
      process.exitCode = 130; // conventional exit code for SIGINT
    };
    rl.on('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    console.log('locci-chat — type a message, /exit to quit (Ctrl+C also works).\n');

    try {
      while (!closing) {
        let line: string;
        try {
          line = (await rl.question('you > ', { signal: session.signal })).trim();
        } catch {
          break; // interface closed underneath us (Ctrl+C)
        }
        if (closing) break;
        if (!line) continue;
        if (line === '/exit' || line === '/quit') break;

        messages.push({ role: 'user', content: line });

        stream = new AbortController();
        let res: Response;
        try {
          res = await fetch(`${API}/chat?events=1`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages, system: opts.system }),
            signal: stream.signal,
          });
        } catch (err) {
          if (closing || (err as Error).name === 'AbortError') break;
          console.error(`\n❌ Server unreachable at ${API}. Start it with: npm run server\n`);
          messages.pop();
          continue;
        }

        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => '');
          console.error(`\n❌ ${res.status} ${res.statusText} ${errText}\n`);
          messages.pop();
          continue;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let assistant = '';
        let buffer = '';
        const names = new Map<string, string>();
        const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
        output.write('AI Assistant > ');

        let aborted = false;
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            aborted = true; // the request was cancelled from under us
            break;
          }
          if (chunk.done || closing) break;
          const { value } = chunk;
          buffer += decoder.decode(value, { stream: true });

          // NDJSON: whole lines only, keep the remainder for the next read.
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            let event: any;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (event.t === 'text') {
              assistant += event.v ?? '';
              output.write(event.v ?? '');
            } else if (event.t === 'tool') {
              // Muted so it reads as activity, not as part of the answer.
              names.set(event.id, event.title ?? event.name);
              output.write(dim(`\n· using ${event.title ?? event.name}…`) + '\n');
            } else if (event.t === 'tool-done') {
              const label = names.get(event.id) ?? 'tool';
              output.write(dim(event.error ? `· ${label} failed: ${event.error}` : `· ${label} ok`) + '\n');
            } else if (event.t === 'error') {
              output.write(dim(`\n⚠️  ${event.v}`) + '\n');
            }
          }
        }
        stream = null;
        if (aborted || closing) break;

        output.write('\n\n');
        messages.push({ role: 'assistant', content: assistant });
      }
    } finally {
      stream?.abort();
      rl.close();
      // Leave the cursor on a clean line whichever way we got here.
      output.write(closing ? 'interrupted.\n' : '\nbye.\n');
    }
  });

const mcp = program.command('mcp').description('Inspect the configured MCP servers');

mcp
  .command('list')
  .description('Connect to every configured MCP server and print its tools')
  .action(async () => {
    // Imported lazily so `status` / `chat` never pay for the MCP deps.
    const { connectMcpServers, mcpConfigPath } = await import('./mcp.js');

    console.log(`config: ${mcpConfigPath()}\n`);
    const runtime = await connectMcpServers();

    if (runtime.servers.length === 0) {
      console.log('No MCP servers configured.');
      console.log('  → cp mcp.example.json mcp.json, or set MCP_COMMAND / MCP_ARGS.');
    }

    try {
      for (const server of runtime.servers) {
        if (server.ok) {
          console.log(`✅ ${server.name} — ${server.toolCount} tool(s)`);
          for (const tool of server.toolNames) console.log(`     ${tool}`);
        } else {
          console.log(`❌ ${server.name} — ${server.error}`);
          process.exitCode = 1;
        }
      }
    } finally {
      await runtime.close();
    }
  });

program
  .command('tui')
  .description('Launch the OpenTUI terminal chat (runs under Bun)')
  .option('-s, --system <prompt>', 'system prompt')
  .action((opts: { system?: string }) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tuiPath = path.join(here, 'tui.tsx');

    // The OpenTUI renderer needs Bun (or Node 26.4+ with --experimental-ffi).
    // If we're already under Bun, reuse this executable; otherwise spawn `bun`.
    const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
    const runtime = isBun ? process.execPath : 'bun';

    const child = spawn(runtime, [tuiPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(opts.system ? { SYSTEM_PROMPT: opts.system } : {}),
      },
    });

    // Forward termination signals so the child can restore the terminal and
    // tear down its own connections before exiting.
    const forward = (sig: NodeJS.Signals) => {
      if (!child.killed) child.kill(sig);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error('❌ Could not find `bun`. The TUI needs Bun (https://bun.sh).');
        console.error('   Install it, or run the client directly: bun src/tui.tsx');
      } else {
        console.error(`❌ Failed to launch TUI: ${err.message}`);
      }
      process.exitCode = 1;
    });

    child.on('exit', (code) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      process.exitCode = code ?? 0;
    });
  });

program.parseAsync();
