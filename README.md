# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one or more GitHub repositories, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)

## Multi-project fork

This fork supports a shared GitHub account and one Feishu bot across multiple projects. The existing repository remains project `default`; add other projects in **Superagent → Settings → Sources → GitHub → Additional projects**, with a unique ID, `owner/repository`, and an absolute path to an existing clone. Each ticket is pinned to a project and gets its own worktree.

In a new Feishu message, write `/project tools <request>` or name the repository explicitly. Follow-ups in that thread inherit its project. With several possible targets the agent asks which project before accepting; use separate threads for separate projects. Per-project GitHub logins and Feishu open IDs may narrow the existing Source allowed lists; blank lists inherit them. The model, bot, account, global rules and concurrency are shared.

Upgrades migrate schema 11 state to schema 12, preserving legacy primary-repository thread IDs and cursors. Additional repositories use namespaced identities. Back up the state database before upgrading; the upstream build cannot open a schema 12 database. Existing tickets retain their accepted repository and prepare command. Project IDs and repositories referenced by tickets cannot be removed or retargeted. This is an application routing constraint, not an OS-level sandbox between repositories.

In a Feishu direct message, send `/projects` to list your accessible project IDs and repositories directly from configuration, without a model call or a ticket. Larger lists use `/projects 2`, etc. The query “列出当前已配置的所有项目及对应仓库，不创建工单。” uses the same deterministic path. The displayed `/project <id>` selectors reflect primary-project renames.
