/** Project selection and authorization shared by intake, execution, and source adapters. */
import { z } from 'zod'
import type { Settings } from './policy.ts'
import type { Ticket, Trigger } from './core/index.ts'

export const RepositorySchema = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
export const ProjectSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/).refine(id => id !== 'default', 'default is reserved for the primary repository'),
  repository: RepositorySchema,
  checkout: z.string().trim().regex(/^\//, 'An absolute path to an existing local clone'),
  githubUsers: z.string().default(''),
  feishuUsers: z.string().default(''),
}).strict()
export type Project = z.infer<typeof ProjectSchema>
export interface SelectedProject { id: string; repository: string; prepare: string }
export const ProjectsSchema = z.array(ProjectSchema).max(100).default([]).superRefine((projects, ctx) => {
  for (const field of ['id', 'repository'] as const) {
    const values = projects.map(project => project[field].toLowerCase())
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: `Duplicate project ${field}` })
  }
})
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
/** Build the same per-ticket worktree preparation as the legacy executor, with a trusted configured clone. */
export function projectPrepare(checkout: string): string {
  const git = `git -C ${quote(checkout)}`
  return `${git} fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "\${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" && ${git} worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"`
}
export function projectsOf(settings: Settings): SelectedProject[] {
  const config = settings.sources.github?.config ?? {}
  const repository = typeof config.repository === 'string' ? config.repository : ''
  const additional = ProjectsSchema.parse(config.projects ?? [])
  return [...repository ? [{ id: 'default', repository, prepare: settings.executor.prepare }] : [],
    ...additional.map(project => ({ id: project.id, repository: project.repository, prepare: projectPrepare(project.checkout) }))]
}
/** Project-specific lists narrow the Source allowed list; an empty list inherits it. */
export function projectAllows(settings: Settings, projectId: unknown, source: string, actor: string): boolean {
  if (typeof projectId !== 'string') return true // legacy records and unresolved questions still reach the router
  const project = projectsOf(settings).find(project => project.id === projectId)
  if (!project) return false
  if (projectId === 'default') return true
  const config = ProjectsSchema.parse(settings.sources.github?.config.projects ?? []).find(project => project.id === projectId)!
  const list = (source === 'github' ? config.githubUsers : source === 'feishu' ? config.feishuUsers : '').split(/[,\s]+/).filter(Boolean)
  return !list.length || list.some(id => id.toLowerCase() === actor.toLowerCase())
}
/** Deterministic routing: explicit selector or repository, then unique thread inheritance, then a sole project. Never guess. */
export function selectProject(trigger: Trigger, projects: SelectedProject[], inherited: readonly string[] = []): SelectedProject | undefined {
  if (trigger.source === 'github' && typeof trigger.meta.projectId === 'string') return projects.find(project => project.id === trigger.meta.projectId)
  const command = /^\s*\/project\s+(\S+)/i.exec(trigger.text)
  if (command) return projects.find(project => project.id.toLowerCase() === command[1]!.toLowerCase())
  const lower = trigger.text.toLowerCase()
  const matched = projects.filter(project => [project.repository, project.repository.split('/')[1]!, project.id !== 'default' ? project.id : '']
    .filter(Boolean).some(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^a-z0-9_.-])${escaped.toLowerCase()}(?=$|[^a-z0-9_.-])`).test(lower)
    }))
  if (matched.length) return matched.length === 1 ? matched[0] : undefined
  const ids = [...new Set(inherited)]
  if (ids.length) return ids.length === 1 ? projects.find(project => project.id === ids[0]) : undefined
  return projects.length === 1 ? projects[0] : undefined
}
export function ticketProject(ticket: Pick<Ticket, 'project'>, settings: Settings): SelectedProject {
  const project = ticket.project ?? projectsOf(settings).find(project => project.id === 'default')
  if (!project) throw new Error('The ticket has no configured project')
  if (!projectsOf(settings).some(current => current.id === project.id && current.repository.toLowerCase() === project.repository.toLowerCase())) {
    throw new Error(`Project ${project.id} was removed or its repository changed; restore it before continuing this ticket`)
  }
  return project
}
