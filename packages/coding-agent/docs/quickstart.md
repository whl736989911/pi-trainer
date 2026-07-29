# Quickstart

This guide starts Pi Trainer from source, configures a model, and optionally enables Feishu/Lark.

## Build

```bash
git clone https://github.com/whl736989911/pi-trainer.git
cd pi-trainer
npm install --ignore-scripts
npm run hydrate:model-data
npm run build
```

Run the terminal Agent:

```bash
node packages/coding-agent/dist/cli.js
```

Development shortcuts:

```bash
./pi-test.sh   # Linux/macOS
./pi-test.ps1  # Windows PowerShell
```

No standalone package is published yet. Do not install the upstream npm package and assume it contains Pi Trainer's Lark or Skill Trainer capabilities.

## Authenticate a model

Start the Agent and run:

```text
/login
```

Select a subscription or API-key provider. You may also set a provider environment variable before launch, for example:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node packages/coding-agent/dist/cli.js
```

Credentials are stored under `~/.pi/agent/`. See [Providers](providers.md) for provider-specific setup.

## Start a training conversation

Pi Trainer is dedicated to Skill training. Describe a real task, its input and desired output. The Agent will progressively collect:

- real cases;
- facts and parameters;
- rules and constraints;
- formulas and units;
- executable steps;
- decisions and exceptions;
- corrections and user confirmations.

Useful commands:

```text
/training-start
/training-status
/knowledge-status
```

The final Skill contains separate `DATA.md`, `RULES.md`, `FORMULAS.md`, `STEPS.md` and `DECISIONS.md` documents. The Agent will not confirm their business correctness on the user's behalf.

## Configure Feishu/Lark

Create an enterprise self-built application in Feishu or Lark, then run:

```bash
node packages/coding-agent/dist/cli.js lark setup
```

Start the gateway:

```bash
node packages/coding-agent/dist/cli.js lark serve
```

Check health:

```bash
node packages/coding-agent/dist/cli.js lark status
```

Use explicit user `open_id` values in the allowlist. Do not use `*` unless every tenant user should be allowed to operate the local Agent.

## First terminal session

Ask a concrete task:

```text
Train a quotation Skill. I will give you one real order and then correct the rules.
```

The normal terminal runtime includes file and shell tools. It runs with the permissions of the current operating-system user and can modify the workspace. Use Git and review changes.

## Project instructions

Pi Trainer loads `AGENTS.md` or `CLAUDE.md` from the global config, parent folders and current workspace. These files are trusted instructions and may influence tool use.

Example:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Run `/reload` or restart after changing resources.

## Common operations

Reference files with `@`:

```bash
node packages/coding-agent/dist/cli.js @README.md "Use this as training material"
```

Manage Sessions inside the TUI with `/resume`, `/new`, `/tree`, `/fork`, `/clone` and `/compact`.

One-shot mode:

```bash
node packages/coding-agent/dist/cli.js -p "Summarize this codebase"
```

Use `--mode json` for JSON events or `--mode rpc` for process integration.

## Data locations

- Agent settings and credentials: `~/.pi/agent/`
- Skill training state: `~/.pi/agent/skill-training/`
- Lark data on Windows: `%LOCALAPPDATA%/pi-lark/`
- Lark data on Linux: `$XDG_DATA_HOME/pi-lark/` or `~/.local/share/pi-lark/`

Back up these directories carefully and never commit their credentials, encryption keys, Sessions or user files.

## Next steps

- [Settings](settings.md)
- [Providers](providers.md)
- [Skills](skills.md)
- [Extensions](extensions.md)
- [SDK](sdk.md)
- [Security](security.md)
- [Development](development.md)
