# Development

Read the repository [AGENTS.md](../../../AGENTS.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md) before changing code.

## Setup

```bash
git clone https://github.com/whl736989911/pi-trainer.git
cd pi-trainer
npm install --ignore-scripts
npm run hydrate:model-data
npm run build
```

Run from source:

```bash
# Linux/macOS
./pi-test.sh

# Windows PowerShell
./pi-test.ps1
```

The scripts preserve the caller's working directory.

## Product modules

Pi Trainer-specific code belongs under:

```text
packages/coding-agent/src/capabilities/
├── lark/
└── skill-trainer/
```

Prefer SDK, inline Extensions, ResourceLoader configuration and Session events. Modify Pi core or TUI only when the required first-class behavior cannot be implemented through those boundaries.

## Compatibility configuration

The coding-agent package retains the `pi` binary and `.pi` configuration directory for compatibility:

```json
{
  "piConfig": {
    "configDir": ".pi"
  }
}
```

Do not rename package imports or configuration paths without a migration plan for existing settings, credentials, Sessions, Lark data and training state.

## Package assets

Always resolve package assets through `src/config.ts` helpers such as `getPackageDir()` and `getThemeDir()`. Never use `__dirname` directly for package assets.

## Debug command

`/debug` is hidden and writes `~/.pi/agent/pi-debug.log`, including rendered TUI lines and recent model messages. Treat this file as sensitive.

## Checks

From the repository root:

```bash
npm run check
npm run build:offline
```

Targeted Capability tests:

```bash
cd packages/coding-agent
npx vitest --run test/lark-built-in.test.ts test/skill-trainer-compiler.test.ts
```

Full package tests:

```bash
npm --prefix packages/coding-agent test
```

Record Windows and Linux results separately. Classify `/bin/bash`, symbolic-link permission, path-format and filesystem error-code differences instead of hiding them in a single pass/fail total.

## Project structure

```text
packages/
  ai/             # LLM provider abstraction
  agent/          # Agent loop and message types
  tui/            # Terminal UI components
  coding-agent/   # Main CLI, Lark and Skill Trainer
  server/         # Server components
  storage/        # Session storage adapters
```

## Upstream synchronization

Keep upstream changes separate from product changes where practical. When syncing:

1. record the upstream commit;
2. resolve Capability conflicts without moving business logic into core;
3. run checks and targeted tests;
4. verify Windows and Linux behavior;
5. rebuild and verify the Lark service command before replacing a running gateway.
