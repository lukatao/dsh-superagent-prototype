import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ProjectsSchema, projectsOf, selectProject, ticketProject } from '../src/projects.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { githubProjectContext } from '../src/sources/github-project.ts'
import { commentTrigger, githubChannel } from '../src/sources/github-trigger.ts'
import { claimPull } from '../src/sources/github-pull.ts'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { testDeployment } from './fixtures/deployment.ts'
import type { Trigger } from '../src/core/index.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

const other = { id: 'tools', repository: 'acme/tools', checkout: "/tmp/a clone's path", githubUsers: '', feishuUsers: '' }
const configured = SettingsSchema.parse({ sources: { github: { config: { repository: 'acme/widgets', projects: [other] } } },
  executor: { prepare: 'legacy-prepare' }, policy: { sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } })
const projects = projectsOf(configured)
const message = (text: string): Trigger => feishu('1', text)
let host: Host | undefined
const directories: string[] = []
afterEach(async () => { await host?.stop(); host = undefined; vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('project selection', () => {
  it('keeps the legacy primary repository and prepare command as the default project', () => {
    expect(projects[0]).toEqual({ id: 'default', repository: 'acme/widgets', prepare: 'legacy-prepare' })
    expect(selectProject(message('fix this'), projects)).toBeUndefined()
    expect(selectProject(message('fix this'), projects.slice(0, 1))?.id).toBe('default')
  })
  it('routes explicit selectors and repository names without a model guessing', () => {
    expect(selectProject(message('/project tools fix this'), projects)?.repository).toBe('acme/tools')
    expect(selectProject(message('check https://github.com/acme/tools/issues/12'), projects)?.id).toBe('tools')
    expect(selectProject(message('修复 widgets 的问题'), projects)?.id).toBe('default')
    expect(selectProject(message('/project typo do something'), projects, ['default'])).toBeUndefined()
    expect(selectProject(message('change widgets and tools'), projects)).toBeUndefined()
    expect(selectProject(message('check toolsmith'), projects)).toBeUndefined()
  })
  it('inherits only an unambiguous thread project; explicit selectors can start a separate project ticket', () => {
    expect(selectProject(message('continue'), projects, ['tools', 'tools'])?.id).toBe('tools')
    expect(selectProject(message('continue'), projects, ['tools', 'default'])).toBeUndefined()
    expect(selectProject(message('/project default check this'), projects, ['tools'])?.id).toBe('default')
  })
  it('rejects duplicate IDs, case-insensitive duplicate repositories and non-absolute clone paths', () => {
    expect(ProjectsSchema.safeParse([other, { ...other, id: 'second', repository: 'ACME/TOOLS' }]).success).toBe(false)
    expect(ProjectsSchema.safeParse([other, { ...other, repository: 'acme/another' }]).success).toBe(false)
    expect(ProjectsSchema.safeParse([{ ...other, checkout: 'relative' }]).success).toBe(false)
    expect(ProjectsSchema.safeParse([{ ...other, id: 'default' }]).success).toBe(false)
  })
  it('quotes configured clone paths and pins a ticket to its accepted preparation command', () => {
    expect(projects[1]!.prepare).toContain("git -C '/tmp/a clone'\\''s path'")
    const fixed = { ...projects[1]!, prepare: 'original-command' }
    expect(ticketProject({ project: fixed }, configured).prepare).toBe('original-command')
    expect(() => ticketProject({ project: { ...fixed, repository: 'acme/unconfigured' } }, configured)).toThrow('removed or its repository changed')
  })
  it('narrows a Source allowed list and revokes an existing project mandate', () => {
    const settings = structuredClone(configured)
    settings.sources.github!.config.projects = [{ ...other, feishuUsers: 'ou_bob' }]
    const scope = { scope: () => ({ listened: true as const, observed: false }) }
    const trigger = { ...message('/project tools check'), meta: { projectId: 'tools' } }
    const policy = settingsPolicy(settings, scope)
    expect(policy.gate(trigger, { subscriptions: [] } as never, [])).toMatchObject({ admissible: false })
    expect(policy.revalidate({ strength: 'explicit', policyVersion: '', actor: trigger.actor, scope: '', basis: { via: 'addressed', addressed: 'direct', scope: trigger.meta } })).toBe(false)
  })
})

describe('runtime routing and execution', () => {
  it('accepts two projects through one Feishu bot, uses each clone, and refuses ambiguous work', async () => {
    host = await startRuntime(undefined, [other])
    const first = await host.acceptedTicket(feishu('1', '/project default check latest commit'))
    const second = await host.acceptedTicket(feishu('2', '/project tools check latest commit'))
    expect(first.ticket.project?.repository).toBe('acme/widgets')
    expect(second.ticket.project?.repository).toBe('acme/tools')
    expect(first.ticket.execution?.directory).not.toBe(second.ticket.execution?.directory)
    const variables = Object.fromEntries(host.runtime.ticketEnvironment(second.ticket).map(value => [value.key, value.value]))
    expect(variables.DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe('acme/tools')
    expect(variables.DSH_SUPERAGENT_PROJECT_ID).toBe('tools')
    expect(host.subprocess.spawn.mock.calls.some(([spec]) => spec.argv.includes(projects[1]!.prepare))).toBe(true)
    const unclear = feishu('3', 'fix it')
    host.runtime.receive(unclear); await host.runtime.idle()
    await expect(host.route({ kind: 'accept', trigger_id: unclear.id, title: 'unclear', worktree_name: 'unclear', acknowledgement: 'Received' })).rejects.toThrow('Project is ambiguous')
    expect(host.runtime.store.tickets.list()).toHaveLength(2)
    const filtered = await host.api('GET', 'tickets?project=tools')
    expect(filtered.status).toBe(200)
    expect((filtered.body.items as { project: { id: string } }[]).map(item => item.project.id)).toEqual(['tools'])
  })
  it('accepts an explicit project clarification in the same pending conversation', async () => {
    host = await startRuntime(undefined, [other])
    const unclear = feishu('1', 'inspect the latest commit')
    host.runtime.receive(unclear); await host.runtime.idle()
    await expect(host.route({ kind: 'accept', trigger_id: unclear.id, title: 'inspect', worktree_name: 'inspect', acknowledgement: 'Received' })).rejects.toThrow('Project is ambiguous')
    const clarified = { ...feishu('2', '/project tools'), threads: unclear.threads }
    host.runtime.receive(clarified); await host.runtime.idle()
    const accepted = await host.route({ kind: 'accept', trigger_id: clarified.id, title: 'inspect', worktree_name: 'inspect', acknowledgement: 'Received' })
    const ticket = host.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
    expect(ticket.project?.id).toBe('tools')
    expect(ticket.mandate.basis.scope?.projectId).toBe('tools')
    expect(host.runtime.store.decisions.get(ticket.decisionId)?.mandate).toEqual(ticket.mandate)
  })
  it('inherits thread context after completion and prevents another project from reaching its worker', async () => {
    host = await startRuntime(undefined, [other])
    const first = await host.acceptedTicket(feishu('1', '/project tools inspect'))
    const origin = host.runtime.store.triggers.get(first.trigger.id)!
    const followup = { ...feishu('2', 'continue'), threads: origin.threads }
    host.runtime.receive(followup); await host.runtime.idle()
    expect(host.runtime.store.triggers.get(followup.id)?.meta.projectId).toBe('tools')
    expect(host.runtime.store.triggers.disposition(followup.id)?.fanout).toContain(first.ticket.id)
    const different = { ...feishu('3', '/project default other work'), threads: origin.threads }
    host.runtime.receive(different); await host.runtime.idle()
    expect(host.runtime.store.triggers.disposition(different.id)?.fanout).toEqual([])
    await expect(host.route({ kind: 'attach', trigger_id: different.id, ticket_id: first.ticket.id })).rejects.toThrow('another project')
  })
  it('filters project-denied messages before subscription fanout, including follow-ups', async () => {
    host = await startRuntime(undefined, [other])
    const first = await host.acceptedTicket(feishu('1', '/project tools inspect'))
    const settings = host.runtime.store.settings()
    settings.sources.github!.config.projects = [{ ...other, feishuUsers: 'ou_bob' }]
    host.runtime.store.saveSettings(settings)
    const trigger = { ...feishu('2', '/project tools continue'), threads: first.trigger.threads }
    expect(host.runtime.receive(trigger)).toBe('filtered')
    expect(host.runtime.store.triggers.disposition(trigger.id)?.fanout).toEqual([])
  })
  it('refuses retargeting or removing a project referenced by an existing ticket', async () => {
    host = await startRuntime(undefined, [other])
    await host.acceptedTicket(feishu('1', '/project tools inspect'))
    const block = host.runtime.settings.block('source:github')
    const value = structuredClone(block.value) as { enabled: boolean; config: Record<string, unknown> }
    value.config.projects = []
    await expect(host.runtime.settings.save('source:github', value, block.revision, 'panel')).rejects.toThrow('referenced by ticket')
  })
})

describe('GitHub repository isolation', () => {
  it('keeps same-number threads, triggers, cursors and PR ownership separate', async () => {
    host = await startRuntime(undefined, [other])
    const base = host.runtime.context(githubKind)
    const primary = githubProjectContext(base)
    const secondary = githubProjectContext(base, other)
    const trigger = commentTrigger({ id: 1, body: '@agent-bot fix typo', user: { login: 'alice' }, created_at: new Date().toISOString() }, { number: 12, isPr: false }, 'conversation', 'agent-bot')
    await primary.receive(trigger); await secondary.receive(trigger)
    const threads = host.runtime.store.threads.list().map(thread => thread.key)
    expect(threads).toContain('github:12')
    expect(threads).toContain('github:acme/tools:12')
    expect(host.runtime.store.db.prepare('SELECT COUNT(*) AS count FROM trigger').get()?.count).toBe(2)
    primary.state.set(KV.github.cursor(12), 'primary')
    secondary.state.set(KV.github.cursor(12), 'secondary')
    expect(primary.state.get(KV.github.cursor(12))).toBe('primary')
    expect(secondary.state.get(KV.github.cursor(12))).toBe('secondary')
    expect(secondary.state.keys(KV.github.cursor)).toContain(KV.github.cursor(12))
    expect(host.runtime.sources.find('https://github.com/acme/tools/issues/12').threads).toEqual(['github:acme/tools:12'])
    expect(host.runtime.sources.find('#12').threads).toEqual(['github:12', 'github:acme/tools:12'])
    const accepted = await host.acceptedTicket(feishu('5', '/project tools inspect'))
    const wrong = { number: 12, title: '', state: 'open', html_url: 'https://github.com/acme/widgets/pull/12', user: { login: 'agent-bot' }, head: { sha: 'a', ref: `agent/${accepted.ticket.execution!.name}`, repo: { full_name: 'acme/widgets' } } }
    expect(claimPull(secondary, accepted.ticket.id, wrong)).toContain('does not belong')
    expect(claimPull(secondary, accepted.ticket.id, { ...wrong, head: { ...wrong.head, repo: { full_name: 'acme/tools' } } })).toBeUndefined()
    expect(host.runtime.store.tickets.get(accepted.ticket.id)?.follows?.[0]?.thread).toBe('github:acme/tools:12')
  })
  it('scopes GitHub reads and sends to configured repositories and refuses arbitrary targets', async () => {
    const deployment = testDeployment({ projects: [other] })
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => args.includes('--slurp') ? '[[]]' : '{}')
    await commands.forRepository('acme/tools').api('issues/12')
    expect(run).toHaveBeenLastCalledWith(deployment.github.cli, ['api', 'repos/acme/tools/issues/12'])
    expect(() => commands.forRepository('attacker/repo')).toThrow('not configured')
    const renamed = new Commands(() => ({ ...deployment, configuredRepository: 'acme/old-widgets' }), {}, new AbortController().signal)
    expect(renamed.forRepository('acme/old-widgets').repository).toBe('acme/widgets')
    const registry = new SourceRegistry(() => configured); registry.register(githubKind)
    await registry.send({ id: 'reply', channel: { ...githubChannel(12), address: { number: '12', repository: 'acme/tools' } }, text: 'done', kind: 'reply' }, commands)
    expect(run.mock.calls.some(([, args]) => args.includes('repos/acme/tools/issues/12/comments') && args.includes('POST'))).toBe(true)
    expect(run.mock.calls.every(([, args]) => !args.some(arg => arg.includes('repos/acme/widgets/')))).toBe(true)
  })
})

it('migrates schema 11 tickets once and preserves their pinned repository and work on reopening', async () => {
  host = await startRuntime()
  const accepted = await host.acceptedTicket(feishu('1', 'inspect'))
  const path = join(host.directory, 'orchestrator.sqlite')
  // Use an independent database snapshot so the fixture runtime remains the sole owner of its own state.
  const dir = mkdtempSync(join(tmpdir(), 'project-migration-')); directories.push(dir)
  const copy = join(dir, 'state.sqlite')
  host.runtime.store.db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`)
  const db = new DatabaseSync(copy)
  db.exec("UPDATE kv SET value = '11' WHERE key = 'schema'; UPDATE ticket SET value = json_remove(value, '$.project')")
  db.close()
  const migrated = new Store(copy)
  expect(migrated.tickets.get(accepted.ticket.id)?.project).toMatchObject({ id: 'default', repository: 'acme/widgets' })
  expect(migrated.tickets.get(accepted.ticket.id)?.execution).toEqual(accepted.ticket.execution)
  const pinned = migrated.tickets.get(accepted.ticket.id)?.project
  migrated.close()
  const reopened = new Store(copy)
  expect(reopened.tickets.get(accepted.ticket.id)?.project).toEqual(pinned)
  reopened.close()
})

describe('primary project rename', () => {
  it('migrates historical project references atomically and accepts the new selector', async () => {
    host = await startRuntime(undefined, [other])
    const accepted = await host.acceptedTicket(feishu('1', '/project default inspect'))
    host.runtime.engine.stopTicket(accepted.ticket.id)
    const block = host.runtime.settings.block('source:github')
    const value = structuredClone(block.value) as { enabled: boolean; config: Record<string, unknown> }
    value.config.primaryProjectId = 'flaggems-sglang'
    await host.runtime.settings.save('source:github', value, block.revision, 'panel')
    const renamed = host.runtime.store.tickets.get(accepted.ticket.id)!
    expect(renamed.project).toEqual({ ...accepted.ticket.project, id: 'flaggems-sglang' })
    expect(renamed.execution).toEqual(accepted.ticket.execution)
    expect(renamed.mandate.basis.scope?.projectId).toBe('flaggems-sglang')
    expect(host.runtime.store.triggers.get(accepted.trigger.id)?.meta.projectId).toBe('flaggems-sglang')
    expect(host.runtime.store.decisions.get(renamed.decisionId)?.mandate?.basis.scope?.projectId).toBe('flaggems-sglang')
    const projects = projectsOf(host.runtime.store.settings())
    expect(selectProject(message('/project flaggems-sglang inspect'), projects)?.repository).toBe('acme/widgets')
    expect(selectProject(message('/project default inspect'), projects)).toBeUndefined()
    expect(host.runtime.ticketEnvironment(renamed).find(value => value.key === 'DSH_SUPERAGENT_PROJECT_ID')?.value).toBe('flaggems-sglang')
  })
  it('refuses renaming while tickets are open without changing settings or records', async () => {
    host = await startRuntime()
    const accepted = await host.acceptedTicket(feishu('1', 'inspect'))
    const block = host.runtime.settings.block('source:github')
    const value = structuredClone(block.value) as { enabled: boolean; config: Record<string, unknown> }
    value.config.primaryProjectId = 'flaggems-sglang'
    await expect(host.runtime.settings.save('source:github', value, block.revision, 'panel')).rejects.toThrow('open tickets')
    expect(host.runtime.store.tickets.get(accepted.ticket.id)?.project?.id).toBe('default')
    expect(projectsOf(host.runtime.store.settings())[0]?.id).toBe('default')
  })
  it('keeps the primary repository thread and cursor namespace when its ID changes', async () => {
    host = await startRuntime()
    const ctx = host.runtime.context(githubKind)
    const renamed = githubProjectContext({ ...ctx, deployment: { ...ctx.deployment, primaryProjectId: 'flaggems-sglang' } })
    renamed.state.set(KV.github.cursor(12), 'checkpoint')
    expect(ctx.state.get(KV.github.cursor(12))).toBe('checkpoint')
    const trigger = commentTrigger({ id: 1, body: '@agent-bot inspect', user: { login: 'alice' } }, { number: 12, isPr: false }, 'conversation', 'agent-bot')
    // Inspect the scoped adapter's event before runtime project selection, whose fake setup still uses default.
    const receive = vi.fn().mockReturnValue('stored')
    await githubProjectContext({ ...ctx, receive, deployment: { ...ctx.deployment, primaryProjectId: 'flaggems-sglang' } }).receive(trigger)
    expect(receive.mock.calls[0]![0]).toMatchObject({ meta: { projectId: 'flaggems-sglang' }, threads: [{ source: 'github', id: '12' }] })
  })
})
