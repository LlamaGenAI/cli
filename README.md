# LlamaGen CLI

`llamagen-cli` is the official command-line tool for the LlamaGen API. It is inspired by Stripe's CLI workflow and gives developers a fast terminal interface for LlamaGen **comic api** and **animation api** jobs.

## Installation

```bash
npm install -g llamagen-cli
```

Then run:

```bash
llamagen --help
```

## Authentication

Use an environment variable:

```bash
export LLAMAGEN_API_KEY=llg_test_...
```

Or store a local development key:

```bash
llamagen config set api-key llg_test_...
```

## Comic API

Create a comic from text plus an uploaded Word, PDF, or TXT script URL:

```bash
llamagen comic create \
  --prompt "american comic illustration, bold outlines" \
  --prompt-url "https://s.llamagen.ai/yourteam/uploads/script-brief.pdf" \
  --size 1024x1024 \
  --wait
```

Other commands:

```bash
llamagen comic get gen_123
llamagen comic continue gen_123 --prompt "add the next page"
llamagen comic update-panel gen_123 --page 0 --panel 1 --prompt "make panel 1 cinematic"
llamagen comic usage
```

## Animation API

```bash
llamagen animation create --prompt "animate the finished comic panel"
llamagen animation get artwork_123
```

## Global flags

```bash
--api-key <key>          Override LLAMAGEN_API_KEY
--base-url <url>         Default: https://api.llamagen.ai
--timeout-ms <ms>        Request timeout
--poll-interval-ms <ms>  Wait polling interval
```

## Development

```bash
npm test
npm pack --dry-run
```

## Search keywords

comic api, animation api, LlamaGen API, CLI, npm, command-line tool
