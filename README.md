# soliconfig config/secrets — GitHub Action

Pull your [soliconfig](https://soliconfig.com) config and secrets at CI/build time
and expose them to the rest of your workflow in one step — as environment
variables for later steps, as a file, or both — with automatic log masking.

Under the hood this is a **composite action** that installs [Bun](https://bun.sh)
(if not already present) and runs the real `soliconfig` CLI (`soliconfig pull`).
It is a thin wrapper around the same core the CLI and JS SDK use — no forked
logic.

## Quick start

```yaml
name: build
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Load soliconfig config/secrets
        uses: vennyx-org/soliconfig-config-action@v1
        with:
          api-key: ${{ secrets.SOLICONFIG_API_KEY }}

      # Values from soliconfig are now in $GITHUB_ENV for every later step:
      - name: Use them
        run: |
          echo "DATABASE_URL is set to: $DATABASE_URL"
          npm run build
```

Store your environment-scoped API key (`sc_...`) as a repository or organization
secret named `SOLICONFIG_API_KEY`, then reference it as
`${{ secrets.SOLICONFIG_API_KEY }}`.

## How targeting works (org / project / environment)

The soliconfig API key is **environment-scoped**. Which organization, project and
environment you get is baked into the key and resolved **server-side**
(`GET /v1/agent/env`) — you do **not** select it in the workflow.

The `org`, `project` and `environment` inputs are therefore **informational
only** (useful to make the workflow self-documenting); they are not sent to the
CLI. To target a different environment, use a different API key.

## Decryption

By default `soliconfig pull` returns values as stored. Depending on your
environment they may still be **encrypted** (`encrypted:` prefix):

- **Server-side decryption** (recommended for `requireApproval=false`
  environments): values come back already decrypted — no extra input needed.
- **Local decryption:** pass the dotenvx-style `private-key` input (store it as a
  secret). The action then runs `pull --decrypt` and writes plaintext.

If any value is still encrypted after the pull, the action emits a warning.

## ⚠️ Automated integrations require `requireApproval=false`

Unattended integrations (CI, this action) only work against environments where
**`requireApproval=false`**. Environments that require human approval to read
secrets will not resolve in an automated workflow — approve access interactively
or use a dedicated CI environment/key with approval disabled.

## Masking

When `mask: true` (the default) every value is registered with GitHub's
`::add-mask::` command **before** it is written anywhere, so it is redacted from
all subsequent logs. Multi-line values are masked per line as well. Do not disable
masking unless you have a specific reason.

Note: masking only affects *this* workflow's log output. Treat the API key and any
private key as secrets and never `echo` values yourself.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | **yes** | — | Environment-scoped API key (`sc_...`). Pass via `secrets.SOLICONFIG_API_KEY`. |
| `org` | no | `""` | Informational only — resolved from the API key, not sent to the CLI. |
| `project` | no | `""` | Informational only (see `org`). |
| `environment` | no | `""` | Informational only (see `org`). |
| `private-key` | no | `""` | dotenvx private key for local decryption. When set, runs `pull --decrypt`. Store as a secret. |
| `format` | no | `dotenv` | Output format for `output-file`/summary: `dotenv` (`KEY="value"`), `env` (`KEY=value`), or `json`. Does not affect `$GITHUB_ENV`. |
| `output-file` | no | `""` | Optional path to write values to, rendered in `format`. Empty = skip file output. |
| `export-env` | no | `true` | Append each `KEY=VALUE` to `$GITHUB_ENV` for later steps. |
| `mask` | no | `true` | Register every value with `::add-mask::`. |
| `api-url` | no | `""` | Override the soliconfig API base URL. |
| `cli-version` | no | `latest` | npm dist-tag/version of the `@vennyx/soliconfig-cli` package run via `bunx`. Pin for reproducible builds. |

## Outputs

| Output | Description |
| --- | --- |
| `env-file` | Absolute path to the raw `.env` file produced by `soliconfig pull`. |
| `count` | Number of config/secret keys emitted (dotenv key headers excluded). |

## Examples

### Write a `.env` file for a later tool

```yaml
- name: Load soliconfig config/secrets
  uses: vennyx-org/soliconfig-config-action@v1
  with:
    api-key: ${{ secrets.SOLICONFIG_API_KEY }}
    export-env: "false"        # don't touch $GITHUB_ENV
    output-file: .env          # write a dotenv file instead
    format: dotenv
```

### Local decryption + JSON output

```yaml
- name: Load soliconfig config/secrets
  uses: vennyx-org/soliconfig-config-action@v1
  with:
    api-key: ${{ secrets.SOLICONFIG_API_KEY }}
    private-key: ${{ secrets.SOLICONFIG_PRIVATE_KEY }}
    format: json
    output-file: config.json
```

A full workflow lives in [`examples/pull-config.yml`](./examples/pull-config.yml).

## What it does, step by step

1. **setup-bun** — installs Bun if it isn't already on the runner (the CLI runs on
   the Bun runtime).
2. **pull** — runs `soliconfig pull -f <tmp>.env` with `SOLICONFIG_TOKEN` set from
   `api-key` (adds `--decrypt --private-key …` when `private-key` is given, and
   `--api-url …` when `api-url` is given).
3. **emit** — parses the pulled file, drops dotenv key headers, masks values,
   appends them to `$GITHUB_ENV`, and optionally writes `output-file`.

## Security notes

- The API key is passed to the CLI via the `SOLICONFIG_TOKEN` environment
  variable, never interpolated into a shell command line.
- The temporary `.env` file is written under `$RUNNER_TEMP` and cleaned up with
  the job's runner workspace.
- Prefer `requireApproval=false` CI environments and least-privilege (read-only)
  API keys.
