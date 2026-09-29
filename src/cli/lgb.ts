#!/usr/bin/env node
import { hashAdminToken } from '../admin/auth.js';

const USAGE = `Usage: lgb <command> [args] [--url <url>] [--token <token>]

Commands:
  bridges ls                             List all bridges
  bridge create <name> [--mode <m>]      Create a bridge
  bridge show <id>                       Show bridge details
  bridge delete <id>                     Delete a bridge
  bridge attach <id> <groupId>           Attach group to bridge
  bridge detach <id> <groupId>           Detach group from bridge
  groups ls [--state <s>]                List groups
  group leave <groupId>                  Make bot leave group
  usage                                  Show monthly usage & quota
  jobs dead [--group <g>]                List dead-letter jobs
  job retry <id>                         Re-queue a dead-letter job
  quota resume                           Lift monthly limit stop
  user show <userId>                     Export user data
  user erase <userId>                    Erase user data (GDPR/APPI)
  hash-token <plain-token>               Compute token hash for config
`;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    console.log(USAGE);
    return;
  }

  // Extract global flags
  let adminUrl = process.env.ADMIN_URL || 'http://127.0.0.1:8081';
  let token = process.env.ADMIN_TOKEN || '';
  const args: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--url' && rawArgs[i + 1]) {
      adminUrl = rawArgs[++i]!;
    } else if (rawArgs[i] === '--token' && rawArgs[i + 1]) {
      token = rawArgs[++i]!;
    } else {
      args.push(rawArgs[i]!);
    }
  }

  const [cmd, sub, ...rest] = args;

  if (cmd === 'hash-token') {
    const plain = sub;
    if (!plain) {
      console.error('Usage: lgb hash-token <plain-token>');
      process.exit(1);
    }
    console.log(hashAdminToken(plain));
    return;
  }

  async function api(path: string, opts: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const res = await fetch(`${adminUrl.replace(/\/+$/, '')}${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`HTTP ${res.status}: ${err}`);
      process.exit(1);
    }
    return res.json();
  }

  if (cmd === 'bridges' && (sub === 'ls' || !sub)) {
    console.log(JSON.stringify(await api('/admin/v1/bridges'), null, 2));
    return;
  }

  if (cmd === 'bridge') {
    if (sub === 'create') {
      const name = rest[0];
      if (!name) {
        console.error('Usage: lgb bridge create <name>');
        process.exit(1);
      }
      console.log(JSON.stringify(await api('/admin/v1/bridges', { body: { name } }), null, 2));
      return;
    }
    if (sub === 'show') {
      console.log(JSON.stringify(await api(`/admin/v1/bridges/${rest[0]}`), null, 2));
      return;
    }
    if (sub === 'delete') {
      console.log(JSON.stringify(await api(`/admin/v1/bridges/${rest[0]}`, { method: 'DELETE' }), null, 2));
      return;
    }
    if (sub === 'attach') {
      const [id, groupId] = rest;
      console.log(JSON.stringify(await api(`/admin/v1/bridges/${id}/groups/${groupId}`, { method: 'POST' }), null, 2));
      return;
    }
    if (sub === 'detach') {
      const [id, groupId] = rest;
      console.log(JSON.stringify(await api(`/admin/v1/bridges/${id}/groups/${groupId}`, { method: 'DELETE' }), null, 2));
      return;
    }
  }

  if (cmd === 'groups' && (sub === 'ls' || !sub)) {
    console.log(JSON.stringify(await api('/admin/v1/groups'), null, 2));
    return;
  }

  if (cmd === 'group' && sub === 'leave') {
    const groupId = rest[0];
    console.log(JSON.stringify(await api(`/admin/v1/groups/${groupId}/leave`, { method: 'POST' }), null, 2));
    return;
  }

  if (cmd === 'usage') {
    console.log(JSON.stringify(await api('/admin/v1/usage'), null, 2));
    return;
  }

  if (cmd === 'jobs' && sub === 'dead') {
    console.log(JSON.stringify(await api('/admin/v1/jobs'), null, 2));
    return;
  }

  if (cmd === 'job' && sub === 'retry') {
    const id = rest[0];
    console.log(JSON.stringify(await api(`/admin/v1/jobs/${id}/retry`, { method: 'POST' }), null, 2));
    return;
  }

  if (cmd === 'quota' && sub === 'resume') {
    console.log(JSON.stringify(await api('/admin/v1/quota/resume', { method: 'POST' }), null, 2));
    return;
  }

  if (cmd === 'user') {
    if (sub === 'show') {
      console.log(JSON.stringify(await api(`/admin/v1/users/${rest[0]}`), null, 2));
      return;
    }
    if (sub === 'erase') {
      console.log(JSON.stringify(await api(`/admin/v1/users/${rest[0]}/data`, { method: 'DELETE' }), null, 2));
      return;
    }
  }

  console.error(`Unknown command: ${args.join(' ')}\n\n${USAGE}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
