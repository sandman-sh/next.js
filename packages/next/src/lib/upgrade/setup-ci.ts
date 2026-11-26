import type { SpawnSyncReturns } from 'child_process'
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'fs'
import { realpath } from 'fs/promises'
import { delimiter, isAbsolute, join, relative, sep } from 'path'

import spawn from 'next/dist/compiled/cross-spawn'

import * as Log from '../../build/output/log'
import { bold, cyan } from '../picocolors'
import { chooseOption } from './choose-option'
import { remainingSteps, setupSecrets, type AgentAuth } from './setup-secrets'

const WORKFLOW = '.github/workflows/next-upgrade.yml'
const TEMPLATE = '.github/actions/next-upgrade/workflow.template.yml'
const SOURCE = 'vercel/next.js'
const SETUP_BRANCH = 'next-upgrade/setup'
const SECRET = 'NEXT_UPGRADE_AGENT_CREDENTIAL'
const PUBLISH_SECRET = 'NEXT_UPGRADE_PUBLISH_TOKEN'
const TITLE = 'Set up scheduled Next.js upgrades'

const AUTH_OPTIONS: Record<AgentAuth, string> = {
  'codex-openai-api-key': 'Codex with an OpenAI API key',
  'claude-anthropic-api-key': 'Claude Code with an Anthropic API key',
  'claude-subscription': 'Claude Code with a Claude subscription',
}

type Auth = AgentAuth
type Policy = 'security' | 'latest'
type SetupResult = {
  status:
    | 'draft_created'
    | 'already_installed'
    | 'existing_draft'
    | 'instructions_printed'
    | 'cancelled'
    | 'blocked'
    | 'failed'
  url?: string
}

type Repository = {
  default_branch: string
  permissions?: { push?: boolean }
  archived?: boolean
  disabled?: boolean
}

type Pull = {
  state?: string
  html_url?: string
  head?: { ref?: string; sha?: string }
  base?: { ref?: string }
}

type FileContent = { type: string; content: string; encoding: string }

class SetupError extends Error {
  constructor(
    message: string,
    readonly status: 'blocked' | 'failed' = 'failed'
  ) {
    super(message)
  }
}

function isPolicy(value: unknown): value is Policy {
  return value === 'security' || value === 'latest'
}

function isAuth(value: string): value is Auth {
  return Object.hasOwn(AUTH_OPTIONS, value)
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

// A bare command name could run a copy planted in the checkout: Windows looks
// in the working directory before PATH, and package runners put the project's
// node_modules/.bin on PATH, along with that of every directory above it, which
// the checkout controls for an app below the Git root. Run commands only from
// absolute PATH directories outside the working directory and node_modules.
function findCommand(name: string, cwd: string, env: NodeJS.ProcessEnv) {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const entry of (pathKey ? env[pathKey] : '')?.split(delimiter) ?? []) {
    if (!isAbsolute(entry)) continue
    let directory: string
    try {
      directory = realpathSync(entry)
    } catch {
      continue
    }
    if (directory.split(sep).includes('node_modules')) continue
    const fromCwd = relative(cwd, directory)
    if (
      fromCwd !== '..' &&
      !fromCwd.startsWith(`..${sep}`) &&
      !isAbsolute(fromCwd)
    ) {
      continue
    }
    for (const extension of extensions) {
      const file = join(directory, name + extension)
      try {
        if (!statSync(file).isFile()) continue
        if (process.platform !== 'win32') accessSync(file, constants.X_OK)
        return file
      } catch {}
    }
  }
  return null
}

function commandNotFound(command: string): SpawnSyncReturns<string> {
  const error: NodeJS.ErrnoException = new Error(`${command} not found`)
  error.code = 'ENOENT'
  return {
    pid: 0,
    output: [],
    stdout: '',
    stderr: '',
    status: null,
    signal: null,
    error,
  }
}

function run({
  command,
  args,
  cwd,
  env,
  input,
}: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  input?: string
}): SpawnSyncReturns<string> {
  const file = findCommand(command, cwd, env)
  if (!file) {
    return commandNotFound(command)
  }
  return spawn.sync(file, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
}

// Esc and Ctrl+C both cancel setup.
async function choose(
  question: string,
  values: Record<string, string>,
  defaultIndex = 0
) {
  const id = await chooseOption(question, values, defaultIndex, true)
  return typeof id === 'string' && Object.hasOwn(values, id) ? id : null
}

function repoPath(root: string, path: string): string {
  const name = relative(root, path).split(sep).join('/') || '.'
  if (
    isAbsolute(name) ||
    name
      .split('/')
      .some((part) => part === '..' || part.toLowerCase() === '.git') ||
    name.trim() !== name ||
    name.includes('\\') ||
    name.includes(':') ||
    name.includes('${{') ||
    /[\u2028-\u202e\u2066-\u2069]/.test(name) ||
    Array.from(name).some(
      (char) => char < ' ' || (char >= '\x7f' && char <= '\x9f')
    )
  ) {
    throw new SetupError('The app has an unsafe path.', 'blocked')
  }
  return name
}

// On Windows, any open that passes through a project link can reach a network
// share and send the user's credentials, and a path checked first can be
// swapped for a link before it is opened. There, setup reads project files
// from the Git objects of HEAD, which never follow worktree links.
function gitObject(root: string, path: string, args: string[]) {
  const name = relative(root, path).split(sep).join('/')
  const git = findCommand('git', root, process.env)
  if (!git) {
    return commandNotFound('git')
  }
  return spawn.sync(git, [...args, `HEAD:${name}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  })
}

export function projectPathExists(
  root: string,
  path: string,
  platform: NodeJS.Platform = process.platform
) {
  if (platform !== 'win32') {
    return existsSync(path)
  }
  return gitObject(root, path, ['cat-file', '-e']).status === 0
}

export function readProjectText(
  root: string,
  path: string,
  platform: NodeJS.Platform = process.platform
) {
  if (platform !== 'win32') {
    return readFileSync(path, 'utf8')
  }
  const result = gitObject(root, path, ['cat-file', 'blob'])
  if (result.status !== 0) {
    throw new SetupError(
      `On Windows, setup reads committed project files. Commit ${relative(root, path).split(sep).join('/')} and run setup again.`,
      'blocked'
    )
  }
  return result.stdout
}

function decodeFile(file: FileContent | null) {
  if (
    file?.type !== 'file' ||
    file.encoding !== 'base64' ||
    typeof file.content !== 'string'
  ) {
    throw new SetupError('GitHub did not return the requested repository file.')
  }
  return Buffer.from(file.content, 'base64').toString('utf8')
}

function renderWorkflow({
  template,
  sha,
  appPath,
  policy,
  auth,
  model,
  effort,
  telemetryDisabled,
  previewPackage,
}: {
  template: string
  sha: string
  appPath: string
  policy: Policy
  auth: Auth
  model: string
  effort: string
  telemetryDisabled: boolean
  previewPackage: boolean
}) {
  // A single-quoted YAML scalar; repoPath already rejects line breaks.
  const scalar = (value: string) => "'" + value.replaceAll("'", "''") + "'"
  const substitutions = [
    [
      `    uses: ${SOURCE}/${WORKFLOW}@__NEXT_UPGRADE_WORKFLOW_SHA__`,
      `    uses: ${SOURCE}/${WORKFLOW}@${sha}`,
    ],
    [
      '      app-path: __NEXT_UPGRADE_APP_PATH__',
      `      app-path: ${scalar(appPath)}`,
    ],
    ['      policy: __NEXT_UPGRADE_POLICY__', `      policy: ${policy}`],
    [
      '      agent-auth: __NEXT_UPGRADE_AGENT_AUTH__',
      `      agent-auth: ${auth}`,
    ],
    ['      model: __NEXT_UPGRADE_MODEL__', `      model: ${scalar(model)}`],
    [
      '      effort: __NEXT_UPGRADE_EFFORT__',
      `      effort: ${scalar(effort)}`,
    ],
    [
      '      telemetry-disabled: __NEXT_UPGRADE_TELEMETRY_DISABLED__',
      `      telemetry-disabled: ${telemetryDisabled}`,
    ],
  ]
  const lines = template.replaceAll('\r\n', '\n').trimEnd().split('\n')
  for (const [placeholder, value] of substitutions) {
    const index = lines.indexOf(placeholder)
    if (index < 0 || lines.lastIndexOf(placeholder) !== index) {
      throw new SetupError(
        'The published workflow template has an invalid placeholder.'
      )
    }
    lines[index] = value
  }

  let workflow = lines.join('\n') + '\n'
  // Validate the caller's supported YAML shape, including indentation and unique keys.
  const shape = lines
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .map(
      (line) =>
        substitutions.find(([, rendered]) => line === rendered)?.[0] ?? line
    )
    .join('\n')
  const expectedShape = [
    'name: Next.js upgrade',
    'on:',
    '  schedule:',
    "    - cron: '0 0 * * 1'",
    '  workflow_dispatch:',
    'permissions: {}',
    'jobs:',
    '  upgrade:',
    '    permissions:',
    '      contents: read',
    substitutions[0][0],
    '    with:',
    ...substitutions.slice(1).map(([placeholder]) => placeholder),
    '    secrets:',
    '      agent-credential: ${{ secrets.' + SECRET + ' }}',
    '      publish-token: ${{ secrets.' + PUBLISH_SECRET + ' }}',
  ].join('\n')
  if (shape !== expectedShape || /__NEXT_UPGRADE_[A-Z_]+__/.test(workflow)) {
    throw new SetupError(
      'The published workflow template has an invalid YAML structure.'
    )
  }
  if (previewPackage) {
    // An unreleased commit is not on npm, so the run installs its preview package.
    const telemetry = substitutions[substitutions.length - 1][1]
    workflow = workflow.replace(
      telemetry + '\n',
      telemetry + '\n      preview-package: true\n'
    )
  }
  return workflow
}

export async function setupUpgradeCI({
  directory,
  policy,
}: {
  directory: string
  policy: true | string
}): Promise<SetupResult> {
  // Keep the invoking user's GitHub environment.
  const env = {
    ...process.env,
    GH_DEBUG: '',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

  try {
    if (policy !== true && !isPolicy(policy)) {
      throw new SetupError('Use security or latest with --ci.', 'blocked')
    }
    directory = await realpath(directory)
    const git = (...args: string[]) =>
      run({ command: 'git', args, cwd: directory, env })
    const top = git('rev-parse', '--show-toplevel')
    const origin = git('remote', 'get-url', 'origin')
    const match = origin.stdout
      ?.trim()
      .match(
        /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+?)(?:\.git)?$/
      )
    if (
      top.status !== 0 ||
      origin.status !== 0 ||
      !match ||
      /\/\.{1,2}$/.test(match[1])
    ) {
      throw new SetupError(
        'Run setup in a Git checkout with a GitHub.com origin.',
        'blocked'
      )
    }

    const root = await realpath(top.stdout.trim())
    let repo = match[1]

    // Slice support: one app with its own npm lockfile. Workspaces and other
    // package managers stop here until the workflow supports them.
    const manifestPath = join(directory, 'package.json')
    if (!projectPathExists(root, manifestPath)) {
      throw new SetupError(
        'Run setup from the directory of a Next.js app.',
        'blocked'
      )
    }
    let manifest: Record<string, unknown> | null = null
    try {
      manifest = JSON.parse(readProjectText(root, manifestPath))
    } catch {}
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      Array.isArray(manifest)
    ) {
      throw new SetupError('Could not read the app package.json.', 'blocked')
    }
    const appManifest = manifest
    const declarations = [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ].flatMap((field) => {
      const dependencies = appManifest[field] as
        | Record<string, unknown>
        | undefined
      return typeof dependencies === 'object' &&
        dependencies !== null &&
        Object.hasOwn(dependencies, 'next')
        ? [dependencies.next]
        : []
    })
    if (
      declarations.length === 0 ||
      !['app', 'pages', 'src/app', 'src/pages'].some((name) =>
        projectPathExists(root, join(directory, name))
      )
    ) {
      throw new SetupError(
        'No Next.js app was found in this directory.',
        'blocked'
      )
    }
    const unsupported =
      'Scheduled upgrades currently support a single app that uses npm, with a committed package-lock.json next to its package.json. Workspaces and other package managers are not supported yet.'
    if (
      declarations.some(
        (specifier) =>
          typeof specifier !== 'string' ||
          /^(?:catalog|workspace):/.test(specifier)
      ) ||
      Object.hasOwn(manifest, 'workspaces') ||
      !projectPathExists(root, join(directory, 'package-lock.json'))
    ) {
      throw new SetupError(unsupported, 'blocked')
    }
    // Scheduled runs read the default branch, so the lockfile must be committed.
    if (
      git('ls-files', '--error-unmatch', '--', 'package-lock.json').status !== 0
    ) {
      throw new SetupError(
        'Commit the package-lock.json, push it to the default branch, and run setup again.',
        'blocked'
      )
    }
    for (let current = directory; ; current = join(current, '..')) {
      if (
        [
          'pnpm-workspace.yaml',
          'pnpm-lock.yaml',
          'yarn.lock',
          'bun.lock',
          'bun.lockb',
        ].some((file) => projectPathExists(root, join(current, file)))
      ) {
        throw new SetupError(unsupported, 'blocked')
      }
      // An app inside an npm workspace shares the root's lockfile and install.
      const ancestorManifest = join(current, 'package.json')
      if (current !== directory && projectPathExists(root, ancestorManifest)) {
        let workspaces = true
        try {
          const parsed = JSON.parse(readProjectText(root, ancestorManifest))
          workspaces = Object.hasOwn(Object(parsed), 'workspaces')
        } catch {}
        if (workspaces) {
          throw new SetupError(unsupported, 'blocked')
        }
      }
      if (current === root || join(current, '..') === current) {
        break
      }
    }
    const appPath = repoPath(root, directory)

    function api<T>(
      endpoint: string,
      description: string,
      options: {
        method?: 'POST'
        body?: object
        missing?: true
        paginate?: true
        jq?: string
      } = {}
    ): T | null {
      const { method, body, missing, jq } = options
      const args = ['api', '--hostname', 'github.com', endpoint]
      if (options.paginate) {
        args.push('--paginate')
      }
      if (jq) {
        // gh prints one JSON value per line for each result of the filter.
        args.push('--jq', jq)
      } else if (options.paginate) {
        args.push('--slurp')
      }
      if (method) {
        args.push('--method', method, '--input', '-')
      }
      const result = run({
        command: 'gh',
        args,
        cwd: root,
        env,
        input: body === undefined ? undefined : JSON.stringify(body),
      })
      if (result.status !== 0) {
        if (missing && /^gh: .*\(HTTP 404\)$/m.test(result.stderr ?? '')) {
          return null
        }
        if (
          (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
        ) {
          throw new SetupError(
            'Install and authenticate the GitHub CLI to set up scheduled upgrades.',
            'blocked'
          )
        }
        throw new SetupError(description)
      }
      try {
        return jq
          ? (result.stdout
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line)) as T)
          : JSON.parse(result.stdout)
      } catch {
        throw new SetupError(description)
      }
    }

    function branchSha(branch: string) {
      const response = api<{ name: string; commit: { sha: string } }>(
        `repos/${repo}/branches/${encodeURIComponent(branch)}`,
        'Could not look up the consumer default branch.'
      )
      if (response?.name !== branch || !isSha(response?.commit?.sha)) {
        throw new SetupError(
          'GitHub did not confirm the requested branch and commit.'
        )
      }
      return response.commit.sha
    }

    const repository = api<Repository>(
      `repos/${repo}`,
      'Could not look up the GitHub repository.'
    )
    const defaultBranch = repository?.default_branch
    if (
      typeof defaultBranch !== 'string' ||
      git('check-ref-format', `refs/heads/${defaultBranch}`).status !== 0 ||
      defaultBranch === SETUP_BRANCH
    ) {
      throw new SetupError('GitHub did not return a valid default branch.')
    }
    const base = defaultBranch

    const fileAt = (
      source: string,
      path: string,
      ref: string,
      description: string,
      missing?: true
    ) =>
      api<FileContent>(
        `repos/${source}/contents/${path}?ref=${ref}`,
        description,
        { missing }
      )

    function pullUrl(pull: Pull) {
      const prefix = `https://github.com/${repo}/pull/`
      const url = pull.html_url
      if (
        !url ||
        !url.toLowerCase().startsWith(prefix.toLowerCase()) ||
        !/^[1-9][0-9]*$/.test(url.slice(prefix.length))
      ) {
        throw new SetupError(
          'GitHub did not return a valid setup pull request URL.'
        )
      }
      return url
    }

    function checkExisting(sha: string): SetupResult | null {
      const installed = fileAt(
        repo,
        WORKFLOW,
        sha,
        'Could not check the default branch for an existing workflow.',
        true
      )
      if (installed) {
        if (installed.type !== 'file') {
          throw new SetupError(
            'The setup workflow path is occupied.',
            'blocked'
          )
        }
        const ref = base.split('/').map(encodeURIComponent).join('/')
        const url = `https://github.com/${repo}/blob/${ref}/${WORKFLOW}`
        Log.info(`Scheduled upgrades are already installed: ${url}`)
        return { status: 'already_installed', url }
      }

      // Setup always uses one branch, so an open pull request from it is the
      // earlier setup.
      const owner = repo.split('/')[0]
      const pulls = api<Pull[]>(
        `repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${SETUP_BRANCH}`)}&base=${encodeURIComponent(base)}`,
        'Could not check for an open setup pull request.'
      )
      if (!Array.isArray(pulls)) {
        throw new SetupError('GitHub did not return the open pull requests.')
      }
      const open = pulls.find(
        (pull) =>
          pull.state === 'open' &&
          pull.base?.ref === base &&
          pull.head?.ref === SETUP_BRANCH
      )
      if (open) {
        const url = pullUrl(open)
        Log.info(`A setup pull request is already open: ${url}`)
        return { status: 'existing_draft', url }
      }
      return null
    }

    const baseSha = branchSha(base)
    const existing = checkExisting(baseSha)
    if (existing) {
      return existing
    }

    // An opt-out in this environment carries into the scheduled runs.
    const telemetryDisabled = Boolean(process.env.NEXT_TELEMETRY_DISABLED)

    // The workflow holds the one policy for the app.
    let selectedPolicy: string | null = policy === true ? null : policy
    if (selectedPolicy === null) {
      if (!interactive) {
        throw new SetupError(
          'Specify security or latest with --ci to set up scheduled upgrades non-interactively.',
          'blocked'
        )
      }
      selectedPolicy = await choose('Choose the upgrade policy:', {
        security: 'Security updates (only for security advisories)',
        latest: 'Latest stable release (every new stable release)',
      })
      if (selectedPolicy === null) {
        return { status: 'cancelled' }
      }
    }
    if (!isPolicy(selectedPolicy)) {
      throw new SetupError('Use security or latest with --ci.', 'blocked')
    }

    if (!interactive) {
      Log.info(
        `Run next upgrade --ci in an interactive terminal to choose the hosted agent. The workflow needs an OpenAI API key, an Anthropic API key, or a Claude subscription token in the ${SECRET} secret and a fine-grained personal access token in the ${PUBLISH_SECRET} secret.`
      )
      return { status: 'instructions_printed' }
    }
    // The workflow runs the default model of its agent CLI.
    const auth = await chooseOption(
      'Choose the hosted agent for the scheduled GitHub workflow:',
      AUTH_OPTIONS,
      0,
      true
    )
    if (typeof auth !== 'string' || !isAuth(auth)) {
      return { status: 'cancelled' }
    }

    // Pin the release that matches the installed Next.js, which the workflow runs from npm.
    // Testing a preview package pins its unreleased commit instead, since it has no release tag.
    const testingSha = process.env.__NEXT_UPGRADE_CI_WORKFLOW_SHA_FOR_TESTING
    let sha: string
    let source: string
    if (testingSha) {
      if (!isSha(testingSha)) {
        throw new SetupError(
          '__NEXT_UPGRADE_CI_WORKFLOW_SHA_FOR_TESTING must be a full commit SHA.',
          'blocked'
        )
      }
      sha = testingSha
      source = `commit ${sha}`
    } else {
      const version = process.env.__NEXT_VERSION
      const tag = `v${version}`
      if (
        !version ||
        git('check-ref-format', `refs/tags/${tag}`).status !== 0
      ) {
        throw new SetupError(
          'Could not determine the installed Next.js version.'
        )
      }
      const tagRef = api<{ object?: { type?: string; sha?: string } }>(
        `repos/${SOURCE}/git/ref/tags/${encodeURIComponent(tag)}`,
        `Could not look up the ${SOURCE} release tag ${tag}.`,
        { missing: true }
      )
      if (!tagRef) {
        throw new SetupError(
          `No ${SOURCE} release tag ${tag} matches the installed Next.js. Install a published release and run setup again.`,
          'blocked'
        )
      }
      let target = tagRef.object
      if (target?.type === 'tag' && isSha(target.sha)) {
        target = api<{ object?: { type?: string; sha?: string } }>(
          `repos/${SOURCE}/git/tags/${target.sha}`,
          `Could not resolve the ${SOURCE} release tag ${tag}.`
        )?.object
      }
      if (target?.type !== 'commit' || !isSha(target.sha)) {
        throw new SetupError(
          `GitHub did not resolve the ${SOURCE} release tag ${tag} to a commit.`
        )
      }
      sha = target.sha
      source = `release tag ${tag}`
    }
    const template = decodeFile(
      fileAt(
        SOURCE,
        TEMPLATE,
        sha,
        `Could not read the workflow template at the ${SOURCE} ${source}.`
      )
    )
    decodeFile(
      fileAt(
        SOURCE,
        WORKFLOW,
        sha,
        `Could not read the reusable workflow at the ${SOURCE} ${source}.`
      )
    )
    // Carry an opt-out the repository or this environment already sets into the scheduled runs.
    const workflow = renderWorkflow({
      template,
      sha,
      appPath,
      policy: selectedPolicy,
      auth,
      // Empty inputs keep the agent CLI's default model and effort.
      model: '',
      effort: '',
      telemetryDisabled,
      previewPackage: Boolean(testingSha),
    })

    // The pull request shows the workflow, so setup does not print it.
    const confirmation = await choose(
      `Open a setup pull request against ${repo} (${base})?`,
      {
        publish: 'Open pull request',
        cancel: 'Cancel',
      }
    )
    if (confirmation !== 'publish') {
      return { status: 'cancelled' }
    }
    if (
      !repository?.permissions?.push ||
      repository.archived ||
      repository.disabled
    ) {
      throw new SetupError(
        'The GitHub account needs write access to the consumer repository.',
        'blocked'
      )
    }

    // A branch left by an earlier attempt may hold other changes, so setup
    // only ever creates it.
    if (
      api(
        `repos/${repo}/git/ref/heads/${SETUP_BRANCH}`,
        'Could not look up the setup branch.',
        { missing: true }
      )
    ) {
      throw new SetupError(
        `The ${SETUP_BRANCH} branch already exists. Delete it and run setup again.`,
        'blocked'
      )
    }
    if (
      api<{ object?: { sha?: string } }>(
        `repos/${repo}/git/refs`,
        'Could not create the setup branch.',
        {
          method: 'POST',
          body: { ref: `refs/heads/${SETUP_BRANCH}`, sha: baseSha },
        }
      )?.object?.sha !== baseSha
    ) {
      throw new SetupError(
        'GitHub did not confirm the setup branch at the expected base commit.'
      )
    }

    // GitHub signs this commit and checks the branch head atomically.
    const headSha = api<{
      data?: { createCommitOnBranch?: { commit?: { oid?: string } } }
    }>(
      'graphql',
      'Could not commit the setup workflow. Check workflow file write permissions.',
      {
        method: 'POST',
        body: {
          query:
            'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
          variables: {
            input: {
              branch: {
                repositoryNameWithOwner: repo,
                branchName: SETUP_BRANCH,
              },
              expectedHeadOid: baseSha,
              message: { headline: TITLE },
              fileChanges: {
                additions: [
                  {
                    path: WORKFLOW,
                    contents: Buffer.from(workflow).toString('base64'),
                  },
                ],
              },
            },
          },
        },
      }
    )?.data?.createCommitOnBranch?.commit?.oid
    if (!isSha(headSha)) {
      throw new SetupError(
        'GitHub did not confirm the workflow commit. Check workflow file write permissions.'
      )
    }

    const pull = api<Pull>(
      `repos/${repo}/pulls`,
      'GitHub could not create the setup pull request.',
      {
        method: 'POST',
        body: { title: TITLE, head: SETUP_BRANCH, base },
      }
    )
    if (
      pull?.state !== 'open' ||
      pull.head?.sha !== headSha ||
      pull.base?.ref !== base
    ) {
      throw new SetupError(
        'GitHub did not confirm the expected setup pull request.'
      )
    }

    const url = pullUrl(pull)
    Log.bootstrap(
      ['', `  ${bold('Setup pull request opened')}`, `  ${cyan(url)}`].join(
        '\n'
      )
    )
    // The next steps name each secret with a command to register it.
    const results = setupSecrets({
      repo,
      auth,
      agentSecret: SECRET,
      publishSecret: PUBLISH_SECRET,
    }).map((secret) => ({ secret, registered: false }))
    Log.bootstrap(remainingSteps({ results, repo, url }))
    return { status: 'draft_created', url }
  } catch (error) {
    if (error instanceof SetupError) {
      Log.error(error.message)
      return { status: error.status }
    }
    // Child process and configuration errors may contain credentials.
    Log.error('Could not complete scheduled Next.js upgrade setup.')
    return { status: 'failed' }
  }
}
