/** Repository-scoped view of the existing GitHub adapter. Legacy primary keys stay readable. */
import { key, type Thread, type ThreadRef, type Ticket, type Trigger } from '../core/index.ts'
import type { Project } from '../projects.ts'
import type { Key } from '../kv.ts'
import type { SourceContext } from './host.ts'

export function githubProjectContext(ctx: SourceContext, project?: Pick<Project, 'id' | 'repository'>): SourceContext {
  const id = project?.id ?? 'default'
  const repository = id === 'default' ? ctx.deployment.repository : project!.repository
  const prefix = id === 'default' ? '' : `${repository.toLowerCase()}:`
  const full = (thread: string) => thread.startsWith('github:') ? `github:${prefix}${thread.slice(7)}` : thread
  const short = (thread: string) => prefix && thread.startsWith(`github:${prefix}`) ? `github:${thread.slice(7 + prefix.length)}` : thread
  const ref = (value: ThreadRef): ThreadRef => value.source === 'github' ? { ...value, id: prefix + value.id } : value
  const owns = (ticket: Ticket) => (ticket.project?.id ?? 'default') === id
  const ticket = (value: Ticket): Ticket => ({ ...value, follows: value.follows?.map(follow => ({ ...follow, thread: short(follow.thread) })) })
  const thread = (value: Thread): Thread => ({ ...value, key: short(value.key), ref: { ...value.ref, id: prefix ? value.ref.id.slice(prefix.length) : value.ref.id } })
  const storage = <V>(name: Key<V>): Key<V> => (prefix ? `project:${repository.toLowerCase()}:${name}` : name) as Key<V>
  return {
    ...ctx,
    deployment: { ...ctx.deployment, repository },
    commands: ctx.commands.forRepository(repository),
    state: {
      get: name => ctx.state.get(storage(name)),
      set: (name, value) => ctx.state.set(storage(name), value),
      keys: family => ctx.state.keys({ ...family, prefix: storage(family.prefix) } as typeof family).map(name => (prefix ? name.slice(`project:${repository.toLowerCase()}:`.length) : name) as typeof name),
    },
    receive: (trigger: Trigger) => ctx.receive({ ...trigger, id: prefix ? key(repository.toLowerCase(), trigger.id) : trigger.id,
      threads: trigger.threads.map(ref), meta: { ...trigger.meta, projectId: id, repository },
      ...trigger.channel ? { channel: { ...trigger.channel, thread: full(trigger.channel.thread), address: { ...trigger.channel.address, repository } } } : {} }),
    threads: {
      get: name => { const value = ctx.threads.get(full(name)); return value && thread(value) },
      subscribed: source => ctx.threads.subscribed(source).filter(value => prefix ? value.ref.id.startsWith(prefix) : !value.ref.id.includes('/')).map(thread),
      describe: (name, value) => ctx.threads.describe(full(name), value),
      patch: (name, value) => ctx.threads.patch(full(name), { ...value, projectId: id, repository }),
    },
    tickets: {
      get: name => { const value = ctx.tickets.get(name); return value && owns(value) ? ticket(value) : undefined },
      open: () => ctx.tickets.open().filter(owns).map(ticket),
      bindThread: (name, value, own) => ctx.tickets.bindThread(name, ref(value), own),
      threadClosed: (value, outcome, at) => ctx.tickets.threadClosed(ref(value), outcome, at),
    },
  }
}
