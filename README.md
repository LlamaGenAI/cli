# @llamagen/cli

Official command-line interface for LlamaGen Comic API workflows.

## Install

```bash
npm install --global @llamagen/cli
```

Node.js 18 or newer is required.

## Sign in

```bash
llamagen auth login
llamagen auth status
```

`auth login` opens `llamagen.ai` in your system browser. The browser reuses
your existing LlamaGen session cookie, asks you to approve the terminal, and
returns a short-lived one-time code to the CLI. Browser cookies are never read
or stored by the CLI.

The resulting account-wide Comic API token is stored in
`~/.llamagen/credentials.json` using mode `0600` and an atomic write. It is
never printed by `auth status`.

To remove only the local CLI credential:

```bash
llamagen auth logout
```

This does not sign out the browser and does not revoke the account-wide Comic
API token used by MCP, SDKs, CI, or other devices.

## Custom backend configuration

The production defaults are `https://llamagen.ai` for browser authentication
and `https://api.llamagen.ai` for the Comic API. Most users do not need to
change them.

For local development or an isolated test deployment, the authentication site
and Comic API are independently configurable:

```bash
llamagen config set site-url https://staging.example.com
llamagen auth login
```

Use a one-off override without changing config:

```bash
llamagen --site-url https://staging.example.com auth login
```

Override the Comic API separately when testing an API deployment:

```bash
llamagen config set api-url https://api.staging.example.com
```

Restore defaults:

```bash
llamagen config unset site-url
llamagen config unset api-url
```

Environment equivalents:

- `LLAMAGEN_SITE_URL`: browser authentication site.
- `LLAMAGEN_API_URL`: Comic API base URL.
- `LLAMAGEN_BASE_URL`: backward-compatible alias for `LLAMAGEN_API_URL`.
- `LLAMAGEN_API_KEY`: non-interactive credential for CI and servers.
- `LLAMAGEN_CONFIG_HOME`: override the local config directory.

## Create comics

```bash
llamagen comic create \
  --prompt "A detective follows a glowing paper crane" \
  --style manga \
  --wait
```

Create from an uploaded script URL:

```bash
llamagen comic create \
  --prompt "Adapt this script into a comic" \
  --prompt-url "https://s.llamagen.ai/yourteam/uploads/script.pdf" \
  --wait
```

Inspect and continue a generation:

```bash
llamagen comic get <generation_id>
llamagen comic continue <generation_id> --prompt "Continue for four panels"
llamagen comic update-panel <generation_id> \
  --page 1 \
  --panel 2 \
  --prompt "Move the camera closer to the hero"
```

Check Comic API usage:

```bash
llamagen comic usage
```

## Authentication automation

Human-readable status:

```bash
llamagen auth status
```

Stable JSON output:

```bash
llamagen auth status --json
```

Offline status only checks whether a local or environment credential exists:

```bash
llamagen auth status --offline
```

For CI and remote SSH sessions without a browser on the same machine, use an
environment variable:

```bash
export LLAMAGEN_API_KEY="<YOUR_LLAMA_GEN_API_TOKEN>"
llamagen comic usage
```

## Configuration precedence

Comic API credentials are resolved in this order:

1. `--api-key`
2. `LLAMAGEN_API_KEY`
3. Local CLI credentials

URLs are resolved in this order:

1. Command-line flag (`--site-url`, `--api-url`, or legacy `--base-url`)
2. Environment variable
3. Local config
4. The URL returned during browser login
5. LlamaGen production defaults

## Commands

```text
llamagen auth login [--no-browser] [--json]
llamagen auth status [--offline] [--json]
llamagen auth logout [--json]

llamagen comic create --prompt <prompt> [--wait]
llamagen comic get <generation_id>
llamagen comic continue <generation_id> --prompt <prompt>
llamagen comic update-panel <generation_id> --page <n> --panel <n> --prompt <prompt>
llamagen comic usage

llamagen config set <site-url|api-url|api-key> <value>
llamagen config get <site-url|api-url|api-key>
llamagen config unset <site-url|api-url|api-key>
```

Comic API documentation: <https://llamagen.ai/comic-api/docs>

MCP and agent setup: <https://llamagen.ai/mcp>
