import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { load } from 'js-yaml'

const nextBin = require.resolve('next/dist/bin/next')
const repoRoot = resolve(__dirname, '../../..')
const fixture = join(__dirname, 'fixtures/single-app-npm')
const nextVersion: string = require('next/package.json').version
const publicSha = 'a'.repeat(40)
const tagObjectSha = 'd'.repeat(40)
const consumerSha = 'b'.repeat(40)
const setupSha = 'c'.repeat(40)
const repo = 'example/consumer'
const workflowPath = '.github/workflows/next-upgrade.yml'
const templatePath = '.github/actions/next-upgrade/workflow.template.yml'
const setupUrl = 'https://github.com/example/consumer/pull/1'
const secretExpression = (name: string) =>
  ['${', `{ secrets.${name} }}`].join('')

const setupHook = `
const fs = require('node:fs')
const Module = require('node:module')
const config = JSON.parse(fs.readFileSync(process.env.UPGRADE_SETUP_TEST, 'utf8'))
if (!config.nonInteractive) {
  Object.defineProperty(process.stdin, 'isTTY', { value: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: true })
}
const choices = [...config.choices]
const load = Module._load
let head = config.existingBranch ? config.consumerSha : null
const response = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const missing = () => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' })
Module._load = function (request, parent, isMain) {
  const actual = load.call(this, request, parent, isMain)
  // Setup's menus come from the helper it shares with next upgrade --agent.
  if (parent?.filename.endsWith('choose-option.js') && request.endsWith('/cli-select')) {
    return async ({ values, defaultValue }) => {
      fs.appendFileSync(config.requests, JSON.stringify({ menu: { values, defaultValue } }) + '\\n')
      const selected = choices.shift()
      // Like pressing Escape in the menu.
      if (selected === '__cancel__') throw undefined
      // Like pressing Ctrl+C in the menu.
      if (selected === '__interrupt__') {
        process.stdin.emit('keypress', '', { ctrl: true, name: 'c' })
        throw undefined
      }
      const key = Object.keys(values).find(key => values[key] === selected) ?? selected
      if (!(key in values)) throw new Error('Unexpected menu: ' + Object.keys(values))
      return { id: key }
    }
  }
  if (!parent?.filename.endsWith('setup-ci.js')) return actual
  if (!request.endsWith('/cross-spawn')) return actual
  return {
    ...actual,
    sync(command, args, options) {
      if (require('node:path').basename(command) !== 'gh') return actual.sync(command, args, options)
      const endpoint = args[3].startsWith('/') ? args[3].slice(1) : args[3]
      const body = options.input ? JSON.parse(options.input) : null
      fs.appendFileSync(config.requests, JSON.stringify({ endpoint, body }) + '\\n')
      const consumer = 'repos/' + config.repo
      const source = 'repos/vercel/next.js'
      if (endpoint === consumer) return response({ default_branch: 'main', permissions: { push: true } })
      if (endpoint === consumer + '/branches/main') {
        return response({ name: 'main', commit: { sha: config.consumerSha } })
      }
      if (endpoint === source + '/git/ref/tags/v' + config.nextVersion) {
        if (config.tagMissing) return missing()
        return response({ object: config.annotatedTag
          ? { type: 'tag', sha: config.tagObjectSha }
          : { type: 'commit', sha: config.publicSha } })
      }
      if (config.annotatedTag && endpoint === source + '/git/tags/' + config.tagObjectSha) {
        return response({ object: { type: 'commit', sha: config.publicSha } })
      }
      if (endpoint.startsWith(consumer + '/contents/')) {
        return config.existingWorkflow ? response({ type: 'file' }) : missing()
      }
      if (endpoint.startsWith(consumer + '/pulls?')) {
        // Setup asks only for open pull requests from its own branch.
        if (!endpoint.includes('head=example%3Anext-upgrade%2Fsetup&base=main')) {
          throw new Error('Unexpected pull request query ' + endpoint)
        }
        return response(config.existingPull ? [{
          state: 'open',
          html_url: config.setupUrl,
          base: { ref: 'main' },
          head: { ref: 'next-upgrade/setup' },
        }] : [])
      }
      if (endpoint === source + '/contents/' + config.templatePath + '?ref=' + config.publicSha) {
        if (config.templateFailure) return missing()
        return response({ type: 'file', encoding: 'base64', content: Buffer.from(config.template).toString('base64') })
      }
      if (endpoint === source + '/contents/' + config.workflowPath + '?ref=' + config.publicSha) {
        return response({ type: 'file', encoding: 'base64', content: Buffer.from('name: workflow').toString('base64') })
      }
      if (endpoint === consumer + '/git/ref/heads/next-upgrade/setup') {
        return head ? response({ object: { sha: head } }) : missing()
      }
      if (endpoint === consumer + '/git/refs' && body) {
        head = config.consumerSha
        return response({ object: { sha: head } })
      }
      if (endpoint === 'graphql' && body) {
        head = config.setupSha
        return response({ data: { createCommitOnBranch: { commit: { oid: head } } } })
      }
      if (endpoint === consumer + '/pulls' && body) {
        return config.pullFailure ? missing() : response({
          state: 'open',
          head: { sha: head },
          base: { ref: 'main' },
          html_url: config.setupUrl,
        })
      }
      throw new Error('Unexpected GitHub request ' + endpoint)
    },
  }
}
`

function runSetup({
  directory,
  choices = [],
  flags = ['--ci=latest'],
  existingWorkflow = false,
  existingPull = false,
  existingBranch = false,
  templateFailure = false,
  pullFailure = false,
  tagMissing = false,
  annotatedTag = false,
  nonInteractive = false,
  agent,
  cwd = directory,
  path = [],
}: {
  directory: string
  choices?: string[]
  flags?: string[]
  existingWorkflow?: boolean
  existingPull?: boolean
  existingBranch?: boolean
  templateFailure?: boolean
  pullFailure?: boolean
  tagMissing?: boolean
  annotatedTag?: boolean
  nonInteractive?: boolean
  agent?: FakeAgent
  cwd?: string
  // PATH entries searched before the stand-in commands.
  path?: string[]
}) {
  const hook = join(directory, 'setup-hook.cjs')
  const config = join(directory, 'setup-test.json')
  const requests = join(directory, 'requests.jsonl')
  writeFileSync(hook, setupHook)
  writeFileSync(requests, '')
  writeFileSync(
    config,
    JSON.stringify({
      repo,
      nextVersion,
      publicSha,
      tagObjectSha,
      consumerSha,
      setupSha,
      setupUrl,
      templatePath,
      workflowPath,
      requests,
      choices,
      existingWorkflow,
      existingPull,
      existingBranch,
      templateFailure,
      pullFailure,
      tagMissing,
      annotatedTag,
      nonInteractive,
      template: readFileSync(join(repoRoot, templatePath), 'utf8'),
    })
  )
  const result = spawnSync(
    process.execPath,
    ['--require', hook, nextBin, 'upgrade', ...flags],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        // Agent CLIs installed on this machine never reach setup.
        PATH: [...path, agentPath(directory, agent)].join(delimiter),
        UPGRADE_SETUP_TEST: config,
      },
    }
  )
  const entries = readFileSync(requests, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    requests: entries.filter((entry) => entry.endpoint !== undefined),
    menus: entries.flatMap((entry) => (entry.menu ? [entry.menu] : [])),
    // The environment each agent CLI started with.
    agentRuns: readAgentRuns(directory),
  }
}

type AgentRun = { name: string; env: Record<string, string | undefined> }

function readAgentRuns(directory: string): AgentRun[] {
  const file = join(directory, 'agent-runs.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const gitPath = (process.env.PATH ?? '')
  .split(delimiter)
  .map((directory) => join(directory, 'git'))
  .find((file) => spawnSync(file, ['--version']).status === 0)

type FakeAgent = {
  name: 'codex' | 'claude'
  models: readonly unknown[]
  // Like pressing Ctrl+C while setup reads the models.
  interrupt?: boolean
}

// A PATH with Git and, when given, a stand-in agent CLI that answers model
// discovery like Codex app-server or Claude stream-json. Setup runs commands
// only from outside the checkout, so they sit next to it.
function agentPath(directory: string, agent?: FakeAgent) {
  const bin = `${directory}-bin`
  rmSync(bin, { recursive: true, force: true })
  mkdirSync(bin)
  if (!gitPath) throw new Error('Could not find Git on PATH.')
  symlinkSync(gitPath, join(bin, 'git'))
  // The hook answers for it, but setup only runs commands it finds.
  for (const name of ['gh']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  }
  rmSync(join(directory, 'agent-runs.jsonl'), { force: true })
  if (agent) {
    const file = join(bin, agent.name)
    writeFileSync(
      file,
      `#!${process.execPath}
const fs = require('node:fs')
const readline = require('node:readline')
const models = ${JSON.stringify(agent.models)}
// Setup gives the CLI a fresh environment, so the path is written here.
fs.appendFileSync(${JSON.stringify(join(directory, 'agent-runs.jsonl'))}, JSON.stringify({ name: ${JSON.stringify(agent.name)}, env: process.env }) + '\\n')
${agent.interrupt ? "process.kill(process.ppid, 'SIGINT')" : ''}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    console.log(JSON.stringify({ id: message.id, result: {} }))
  } else if (message.method === 'model/list') {
    console.log(JSON.stringify({ id: message.id, result: { data: models, nextCursor: null } }))
  } else if (message.type === 'control_request') {
    console.log(JSON.stringify({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response: { models } } }))
  }
})
`
    )
    chmodSync(file, 0o755)
  }
  return bin
}

const agentMenu = {
  'codex-openai-api-key': 'Codex with an OpenAI API key',
  'claude-anthropic-api-key': 'Claude Code with an Anthropic API key',
  'claude-subscription': 'Claude Code with a Claude subscription',
}

const defaultModelInfo = (name: string) =>
  `The workflow uses the default model of its ${name} CLI. Install ${name} here to choose another model.`

// Scheduled upgrades support a single app that uses npm.
function copyApp(target: string) {
  cpSync(fixture, target, { recursive: true })
  // Setup only checks that a lockfile is committed, so a minimal one will do;
  // the index is enough for Git.
  writeFileSync(
    join(target, 'package-lock.json'),
    JSON.stringify({
      name: 'scheduled-upgrade-fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {},
    })
  )
  git(target, 'add', '--all', '.')
}

function editManifest(
  directory: string,
  edit: (manifest: {
    dependencies: Record<string, string>
    workspaces?: string[]
  }) => void
) {
  const path = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  edit(manifest)
  writeFileSync(path, JSON.stringify(manifest, null, 2))
}

function committedWorkflow(result: ReturnType<typeof runSetup>) {
  const commit = result.requests.find(({ endpoint }) => endpoint === 'graphql')
  const [file] = commit.body.variables.input.fileChanges.additions
  expect(file.path).toBe(workflowPath)
  return Buffer.from(file.contents, 'base64').toString()
}

function git(directory: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Could not initialize the test checkout.')
  }
}

const unsupported =
  'Scheduled upgrades currently support a single app that uses npm'

describe('next upgrade --ci', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'next-upgrade-ci-'))
    git(directory, 'init')
    git(directory, 'remote', 'add', 'origin', `https://github.com/${repo}.git`)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
    rmSync(`${directory}-bin`, { recursive: true, force: true })
  })

  it('renders the app at the Git root with the chosen policy and prints the confirmed pull request and secret', () => {
    copyApp(directory)
    const result = runSetup({
      directory,
      flags: ['--ci=security'],
      choices: ['codex-openai-api-key', 'publish'],
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain(setupUrl)
    // The next steps name both required secrets with a command to register each.
    expect(result.output).toContain(
      'gh secret set NEXT_UPGRADE_AGENT_CREDENTIAL --repo github.com/example/consumer'
    )
    expect(result.output).toContain(
      'gh secret set NEXT_UPGRADE_PUBLISH_TOKEN --repo github.com/example/consumer'
    )
    expect(result.output).toContain('hosted Codex agent')
    expect(result.output).toContain('Finish setup in 3 steps')
    // Each hosted agent brings its own credential; none goes through a gateway.
    expect(result.output).toContain(
      'Choose the hosted agent for the scheduled GitHub workflow:'
    )
    expect(result.menus[0]).toEqual({ values: agentMenu, defaultValue: 0 })
    // Pressing Enter through setup opens the pull request.
    expect(result.menus.find(({ values }) => 'publish' in values)).toEqual({
      values: { publish: 'Open pull request', cancel: 'Cancel' },
      defaultValue: 0,
    })
    // Setup never merges the pull request.
    expect(
      result.requests.some(({ endpoint }) => /\/merge$/.test(endpoint))
    ).toBe(false)
    // An explicit policy skips the question, and the pull request shows the workflow.
    expect(result.output).not.toContain('Choose the upgrade policy')
    expect(result.output).not.toContain('uses: vercel/next.js')
    // Without a Codex CLI here, the workflow keeps the CLI default model.
    expect(result.output).toContain(defaultModelInfo('Codex'))
    expect(result.output).not.toContain('model should run the upgrade')
    expect(result.output).toContain(
      `Open a setup pull request against ${repo} (main)?`
    )
    expect(result.output).toContain('Setup pull request opened')
    expect(
      result.requests.some(({ endpoint }) =>
        endpoint.startsWith('repos/vercel/next.js/branches/')
      )
    ).toBe(false)
    const workflow = committedWorkflow(result)
    expect(workflow).toContain("      app-path: '.'\n")
    expect(load(workflow)).toEqual({
      name: 'Next.js upgrade',
      on: {
        schedule: [{ cron: '0 0 * * 1' }],
        workflow_dispatch: null,
      },
      permissions: {},
      jobs: {
        upgrade: {
          permissions: { contents: 'read' },
          uses: `vercel/next.js/.github/workflows/next-upgrade.yml@${publicSha}`,
          with: {
            'app-path': '.',
            policy: 'security',
            'agent-auth': 'codex-openai-api-key',
            model: '',
            effort: '',
            // The test environment sets NEXT_TELEMETRY_DISABLED.
            'telemetry-disabled': true,
          },
          secrets: {
            'agent-credential': secretExpression(
              'NEXT_UPGRADE_AGENT_CREDENTIAL'
            ),
            'publish-token': secretExpression('NEXT_UPGRADE_PUBLISH_TOKEN'),
          },
        },
      },
    })
    const pull = result.requests.find(
      ({ endpoint, body }) => endpoint.endsWith('/pulls') && body
    )
    expect(pull).toMatchObject({
      body: {
        base: 'main',
        head: 'next-upgrade/setup',
      },
    })
    // The setup opens as a regular pull request, not a draft.
    expect(pull.body).not.toHaveProperty('draft')
  })

  it('runs Git, the GitHub CLI, and agent CLIs from PATH, never from the checkout', () => {
    copyApp(directory)
    // Commands planted in the checkout, found first through a relative and
    // an absolute PATH entry, e.g. node_modules/.bin from a package runner.
    const marker = join(`${directory}-bin`, 'planted-ran')
    const planted = join(directory, 'node_modules/.bin')
    mkdirSync(planted, { recursive: true })
    for (const name of ['git', 'gh', 'codex', 'claude']) {
      // A shell builtin, since this PATH has no touch.
      const script = `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`
      writeFileSync(join(directory, name), script, { mode: 0o755 })
      writeFileSync(join(planted, name), script, { mode: 0o755 })
    }
    const result = runSetup({
      directory,
      flags: ['--ci=security'],
      choices: ['codex-openai-api-key', 'publish'],
      path: ['.', planted],
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain(setupUrl)
    expect(existsSync(marker)).toBe(false)
  })

  it('renders the path of an app below the Git root', () => {
    const frontend = join(directory, 'frontend')
    copyApp(frontend)
    const result = runSetup({
      directory,
      cwd: frontend,
      choices: ['codex-openai-api-key', 'publish'],
    })
    expect(result.status).toBe(0)
    expect(load(committedWorkflow(result))).toMatchObject({
      jobs: {
        upgrade: { with: { 'app-path': 'frontend', policy: 'latest' } },
      },
    })
  })

  it('never runs Git from node_modules/.bin above an app below the Git root', () => {
    const frontend = join(directory, 'frontend')
    copyApp(frontend)
    // Package runners also put the Git root's node_modules/.bin on PATH.
    const marker = join(`${directory}-bin`, 'planted-ran')
    const planted = join(directory, 'node_modules/.bin')
    mkdirSync(planted, { recursive: true })
    // A shell builtin, since this PATH has no touch.
    writeFileSync(
      join(planted, 'git'),
      `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`,
      { mode: 0o755 }
    )
    const result = runSetup({
      directory,
      cwd: frontend,
      flags: ['--ci=security'],
      choices: ['codex-openai-api-key', 'publish'],
      path: [planted],
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain(setupUrl)
    expect(existsSync(marker)).toBe(false)
  })

  it('asks for the policy with plain --ci and renders Claude Code with an Anthropic API key', () => {
    copyApp(directory)
    const result = runSetup({
      directory,
      flags: ['--ci'],
      choices: ['latest', 'claude-anthropic-api-key', 'publish'],
      annotatedTag: true,
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain('Choose the upgrade policy:')
    expect(result.menus[0].values).toEqual({
      security: 'Security updates (only for security advisories)',
      latest: 'Latest stable release (every new stable release)',
    })
    expect(result.output).toContain(setupUrl)
    expect(result.output).toContain(defaultModelInfo('Claude Code'))
    expect(load(committedWorkflow(result))).toMatchObject({
      jobs: {
        upgrade: {
          uses: `vercel/next.js/.github/workflows/next-upgrade.yml@${publicSha}`,
          with: {
            'app-path': '.',
            policy: 'latest',
            'agent-auth': 'claude-anthropic-api-key',
            model: '',
            effort: '',
          },
        },
      },
    })
  })

  describe('with an agent CLI on PATH', () => {
    const codex = 'codex-openai-api-key'
    const claude = 'claude-anthropic-api-key'
    // Like Codex app-server, the default model need not come first.
    const codexModels = [
      {
        model: 'gpt-fast',
        displayName: 'Fast',
        description: 'Quick',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'high' },
        ],
      },
      { model: 'gpt-default', displayName: 'Default', isDefault: true },
    ]
    const claudeModels = [
      { value: 'default', displayName: 'Default' },
      {
        value: 'opus',
        displayName: 'Opus',
        description: 'Most capable',
        supportedEffortLevels: ['low', 'high'],
      },
      // Claude Code names some models with brackets.
      { value: 'sonnet[1m]', displayName: 'Sonnet (1M context)' },
    ]
    const agents = {
      [codex]: { name: 'codex', models: codexModels },
      [claude]: { name: 'claude', models: claudeModels },
    } as const
    const setup = (auth: keyof typeof agents, choices: string[]) => {
      copyApp(directory)
      return runSetup({
        directory,
        agent: agents[auth],
        choices: [auth, ...choices],
      })
    }
    const rendered = (result: ReturnType<typeof runSetup>) =>
      (
        load(committedWorkflow(result)) as {
          jobs: { upgrade: { with: Record<string, unknown> } }
        }
      ).jobs.upgrade.with
    const effortQuestion = 'Which reasoning effort should the upgrade use?'

    it.each([
      [
        'a Codex model and effort',
        codex,
        ['gpt-fast', 'high'],
        'gpt-fast',
        'high',
      ],
      ['the default Codex model', codex, ['gpt-default'], '', ''],
      [
        'a Claude Code model at its default effort',
        claude,
        ['opus', 'default'],
        'opus',
        '',
      ],
      [
        'a Claude Code model named with brackets',
        claude,
        ['sonnet[1m]'],
        'sonnet[1m]',
        '',
      ],
    ] as const)('renders %s', (_, auth, choices, model, effort) => {
      const result = setup(auth, [...choices, 'publish'])
      expect(result.status).toBe(0)
      const displayName = auth === codex ? 'Codex' : 'Claude Code'
      expect(result.output).toContain(
        `Which ${displayName} model should run the upgrade?`
      )
      expect(result.output).not.toContain(defaultModelInfo(displayName))
      // The model menu highlights the agent CLI default.
      expect(result.menus[1]).toEqual(
        auth === codex
          ? {
              values: { 'gpt-fast': 'Fast — Quick', 'gpt-default': 'Default' },
              defaultValue: 1,
            }
          : {
              values: {
                default: 'Default',
                opus: 'Opus — Most capable',
                'sonnet[1m]': 'Sonnet (1M context)',
              },
              defaultValue: 0,
            }
      )
      if (choices.length > 1) {
        expect(result.output).toContain(effortQuestion)
        expect(result.menus[2]).toEqual({
          values: { default: 'Model default', low: 'low', high: 'high' },
          defaultValue: 0,
        })
      } else {
        // A model without efforts skips the question.
        expect(result.output).not.toContain(effortQuestion)
      }
      expect(rendered(result)).toMatchObject({
        'agent-auth': auth,
        model,
        effort,
      })
    })

    it('goes back one question with Escape', () => {
      const result = setup(codex, [
        // Back from the model to the agent.
        '__cancel__',
        codex,
        'gpt-fast',
        // Back from the effort to the model.
        '__cancel__',
        'gpt-fast',
        'low',
        'publish',
      ])
      expect(result.status).toBe(0)
      expect(
        result.menus
          .slice(0, 7)
          .map(({ values, defaultValue }) => [
            Object.keys(values)[0],
            defaultValue,
          ])
      ).toEqual([
        [codex, 0],
        ['gpt-fast', 1],
        // Each question highlights the previous answer.
        [codex, 0],
        ['gpt-fast', 1],
        ['default', 0],
        ['gpt-fast', 0],
        ['default', 0],
      ])
      expect(rendered(result)).toMatchObject({
        model: 'gpt-fast',
        effort: 'low',
      })
    })

    it.each([
      // Discovery runs for every installed CLI, not only the chosen one.
      ['codex', claude],
      ['claude', codex],
    ] as const)(
      'reads the %s models a fresh install offers before the agent menu',
      (name, chosen) => {
        copyApp(directory)
        const result = runSetup({
          directory,
          agent: name === 'codex' ? agents[codex] : agents[claude],
          choices: [chosen, 'publish'],
        })
        expect(result.status).toBe(0)
        expect(result.agentRuns).toHaveLength(1)
        const [{ name: ran, env }] = result.agentRuns
        expect(ran).toBe(name)
        // None of this user's agent configuration reaches the CLI.
        const home = env.HOME!
        expect(home).toBeDefined()
        expect(home).not.toBe(process.env.HOME)
        expect(env).toMatchObject({
          USERPROFILE: home,
          CODEX_HOME: join(home, 'codex'),
          CLAUDE_CONFIG_DIR: join(home, 'claude'),
          XDG_CONFIG_HOME: join(home, 'config'),
        })
        expect(env).not.toHaveProperty('UPGRADE_SETUP_TEST')
        expect(env).not.toHaveProperty('NEXT_TELEMETRY_DISABLED')
        // Setup removes the fresh home once the questions are answered.
        expect(existsSync(home)).toBe(false)
      }
    )

    it('makes no changes when model discovery is interrupted', () => {
      copyApp(directory)
      const result = runSetup({
        directory,
        agent: { ...agents[codex], interrupt: true },
        choices: [codex, 'publish'],
      })
      expect(result.status).toBe(0)
      expect(result.agentRuns).toHaveLength(1)
      expect(result.menus).toEqual([])
      expect(result.output).not.toContain(defaultModelInfo('Codex'))
      expect(result.requests.every(({ body }) => body === null)).toBe(true)
    })

    it('makes no changes when the model question is interrupted', () => {
      const result = setup(codex, ['__interrupt__'])
      expect(result.status).toBe(0)
      expect(result.output).not.toContain('Open a setup pull request')
      expect(result.requests.every(({ body }) => body === null)).toBe(true)
    })
  })

  it('makes no changes when the policy question is cancelled', () => {
    copyApp(directory)
    const result = runSetup({
      directory,
      flags: ['--ci'],
      choices: ['__cancel__'],
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain('Choose the upgrade policy:')
    expect(result.requests.every(({ body }) => body === null)).toBe(true)
  })

  it('stops for plain --ci when not interactive', () => {
    copyApp(directory)
    const result = runSetup({
      directory,
      flags: ['--ci'],
      nonInteractive: true,
    })
    expect(result.status).toBe(1)
    expect(result.output).toContain(
      'Specify security or latest with --ci to set up scheduled upgrades non-interactively.'
    )
    expect(result.output).not.toContain('Choose the upgrade policy')
    expect(result.requests.every(({ body }) => body === null)).toBe(true)
  })

  it('rejects an unsupported policy before contacting GitHub', () => {
    copyApp(directory)
    const result = runSetup({ directory, flags: ['--ci=experimental-future'] })
    expect(result.status).toBe(1)
    expect(result.output).toContain('Use security or latest with --ci.')
    expect(result.requests).toEqual([])
  })

  it('stops outside an app directory', () => {
    const result = runSetup({ directory })
    expect(result.status).toBe(1)
    expect(result.output).toContain(
      'Run setup from the directory of a Next.js app.'
    )
    expect(result.requests.every(({ body }) => body === null)).toBe(true)
  })

  it.each([
    [
      'a missing package-lock.json',
      (app: string) => rmSync(join(app, 'package-lock.json')),
    ],
    [
      'a workspaces field',
      (app: string) =>
        editManifest(app, (manifest) => {
          manifest.workspaces = ['packages/*']
        }),
    ],
    [
      'a catalog: specifier for next',
      (app: string) =>
        editManifest(app, (manifest) => {
          manifest.dependencies.next = 'catalog:'
        }),
    ],
    [
      'a workspace: specifier for next',
      (app: string) =>
        editManifest(app, (manifest) => {
          manifest.dependencies.next = 'workspace:*'
        }),
    ],
    [
      'a pnpm-workspace.yaml in the app',
      (app: string) =>
        writeFileSync(join(app, 'pnpm-workspace.yaml'), 'packages: []\n'),
    ],
    [
      'a yarn.lock in the app',
      (app: string) => writeFileSync(join(app, 'yarn.lock'), ''),
    ],
    [
      'a bun.lockb in the app',
      (app: string) => writeFileSync(join(app, 'bun.lockb'), ''),
    ],
  ])('stops for %s', (_, change) => {
    copyApp(directory)
    change(directory)
    const result = runSetup({
      directory,
      choices: ['codex-openai-api-key', 'publish'],
    })
    expect(result.status).toBe(1)
    expect(result.output).toContain(unsupported)
    // The layout check runs before any GitHub request.
    expect(result.requests).toEqual([])
  })

  it.each([
    ['a pnpm-lock.yaml', 'pnpm-lock.yaml', ''],
    ['a bun.lock', 'bun.lock', ''],
    [
      'an npm workspace root',
      'package.json',
      JSON.stringify({ private: true, workspaces: ['frontend'] }),
    ],
  ])('stops for %s at the Git root above the app', (_, file, contents) => {
    const frontend = join(directory, 'frontend')
    copyApp(frontend)
    writeFileSync(join(directory, file), contents)
    const result = runSetup({
      directory,
      cwd: frontend,
      choices: ['codex-openai-api-key', 'publish'],
    })
    expect(result.status).toBe(1)
    expect(result.output).toContain(unsupported)
    // The layout check runs before any GitHub request.
    expect(result.requests).toEqual([])
  })

  it('stops for a package-lock.json that is not committed', () => {
    copyApp(directory)
    git(directory, 'rm', '--cached', '--quiet', 'package-lock.json')
    const result = runSetup({ directory })
    expect(result.status).toBe(1)
    expect(result.output).toContain(
      'Commit the package-lock.json, push it to the default branch, and run setup again.'
    )
    expect(result.requests).toEqual([])
  })

  it('stops when a setup branch is left from an earlier attempt', () => {
    copyApp(directory)
    const result = runSetup({
      directory,
      choices: ['codex-openai-api-key', 'publish'],
      existingBranch: true,
    })
    expect(result.status).toBe(1)
    expect(result.requests.every(({ body }) => body === null)).toBe(true)
    expect(result.output).toContain(
      'The next-upgrade/setup branch already exists. Delete it and run setup again.'
    )
  })

  it.each(['workflow', 'pull request'])(
    'stops for an existing %s',
    (existing) => {
      copyApp(directory)
      const result = runSetup({
        directory,
        existingWorkflow: existing === 'workflow',
        existingPull: existing === 'pull request',
      })
      expect(result.status).toBe(0)
      expect(result.requests.every(({ body }) => body === null)).toBe(true)
      expect(result.output).toContain(
        existing === 'workflow' ? 'already installed' : setupUrl
      )
    }
  )

  it.each(['templateFailure', 'pullFailure'] as const)(
    'reports %s without claiming a setup pull request',
    (failure) => {
      copyApp(directory)
      const result = runSetup({
        directory,
        choices: ['codex-openai-api-key', 'publish'],
        [failure]: true,
      })
      expect(result.status).toBe(1)
      expect(result.output).not.toContain('Setup pull request opened')
      expect(result.output).toContain(
        failure === 'templateFailure'
          ? 'Could not read the workflow template'
          : 'GitHub could not create the setup pull request.'
      )
    }
  )

  it('pins the commit of a preview package under test instead of a release tag', () => {
    copyApp(directory)
    process.env.__NEXT_UPGRADE_CI_WORKFLOW_SHA_FOR_TESTING = publicSha
    try {
      const result = runSetup({
        directory,
        choices: ['codex-openai-api-key', 'publish'],
        // A preview package has no release tag.
        tagMissing: true,
      })
      expect(result.status).toBe(0)
      expect(
        result.requests.some(({ endpoint }) =>
          endpoint.startsWith('repos/vercel/next.js/git/')
        )
      ).toBe(false)
      const { uses, with: inputs } = (
        load(committedWorkflow(result)) as {
          jobs: { upgrade: { uses: string; with: Record<string, unknown> } }
        }
      ).jobs.upgrade
      expect(uses).toBe(
        `vercel/next.js/.github/workflows/next-upgrade.yml@${publicSha}`
      )
      // The commit is not on npm, so the run installs its preview package.
      expect(inputs['preview-package']).toBe(true)
    } finally {
      delete process.env.__NEXT_UPGRADE_CI_WORKFLOW_SHA_FOR_TESTING
    }
  })

  it('stops for a testing commit that is not a full SHA', () => {
    copyApp(directory)
    process.env.__NEXT_UPGRADE_CI_WORKFLOW_SHA_FOR_TESTING = 'main'
    try {
      const result = runSetup({
        directory,
        choices: ['codex-openai-api-key', 'publish'],
      })
      expect(result.status).toBe(1)
      expect(result.output).toContain(
        '__NEXT_UPGRADE_CI_WORKFLOW_SHA_FOR_TESTING must be a full commit SHA.'
      )
      expect(result.requests.every(({ body }) => body === null)).toBe(true)
    } finally {
      delete process.env.__NEXT_UPGRADE_CI_WORKFLOW_SHA_FOR_TESTING
    }
  })

  it('stops without a release tag for the installed version', () => {
    copyApp(directory)
    const result = runSetup({
      directory,
      choices: ['codex-openai-api-key', 'publish'],
      tagMissing: true,
    })
    expect(result.status).toBe(1)
    expect(result.output).toContain(
      `No vercel/next.js release tag v${nextVersion} matches the installed Next.js`
    )
    expect(result.requests.every(({ body }) => body === null)).toBe(true)
  })

  describe('agent credential', () => {
    const credentials = [
      {
        auth: 'codex-openai-api-key',
        steps: ['Create an API key in your OpenAI account and copy it.'],
      },
      {
        auth: 'claude-anthropic-api-key',
        steps: [
          'Create an API key in your Claude Console account and copy it.',
        ],
      },
      {
        auth: 'claude-subscription',
        steps: [
          'In another terminal, run: claude setup-token',
          'Sign in, then copy the token it prints.',
        ],
      },
    ] as const

    it.each(credentials)(
      'lists how to create the $auth credential',
      ({ auth, steps }) => {
        copyApp(directory)
        const result = runSetup({ directory, choices: [auth, 'publish'] })
        expect(result.status).toBe(0)
        expect(load(committedWorkflow(result))).toMatchObject({
          jobs: { upgrade: { with: { 'agent-auth': auth } } },
        })
        const closing = result.output.slice(
          result.output.indexOf('Finish setup in 3 steps')
        )
        expect(closing).toContain('1. Add NEXT_UPGRADE_AGENT_CREDENTIAL')
        for (const step of steps) {
          expect(closing).toContain(step)
        }
        expect(closing).toContain(
          'gh secret set NEXT_UPGRADE_AGENT_CREDENTIAL --repo github.com/example/consumer'
        )
        expect(closing).toContain('2. Add NEXT_UPGRADE_PUBLISH_TOKEN')
        expect(closing).toContain('3. Merge the setup pull request')
      }
    )
  })

  it('prints instructions instead of prompting when not interactive', () => {
    copyApp(directory)
    const result = runSetup({ directory, nonInteractive: true })
    expect(result.status).toBe(0)
    expect(result.output).toContain(
      'Run next upgrade --ci in an interactive terminal'
    )
    expect(result.output).toContain(
      'The workflow needs an OpenAI API key, an Anthropic API key, or a Claude subscription token in the NEXT_UPGRADE_AGENT_CREDENTIAL secret'
    )
    expect(result.requests.every(({ body }) => body === null)).toBe(true)
  })

  it('rejects --agent and --ci together before contacting GitHub', () => {
    const result = runSetup({ directory, flags: ['--ci', '--agent'] })
    expect(result.status).toBe(1)
    expect(result.requests).toEqual([])
  })
})
