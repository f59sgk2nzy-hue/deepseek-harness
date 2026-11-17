# Hermes bot packs

Copy-ready personas and skills for [Hermes Agent](https://hermes-agent.nousresearch.com/docs/). Each pack is a `SOUL.md` (identity, slot #1 of the system prompt), a `config.snippet.yaml`, and SKILL.md skills in the Hermes layout (`~/.hermes/skills/<category>/<name>/SKILL.md`).

| Pack | Purpose |
|-|-|
| `engineer` | Coding bot: verify-before-done, TDD loop, PR workflow |
| `researcher` | Source-grounded research and decision briefs |
| `operator` | Cautious ops/automation with approval and rollback discipline |
| `bot-creator` | Skill that generates new packs from a short brief |

## Install

```sh
./install.sh engineer --dry-run   # preview
./install.sh engineer             # installs to $HERMES_HOME or ~/.hermes, backing up existing files
```

Then merge the pack's `config.snippet.yaml` into `~/.hermes/config.yaml` and restart (`hermes gateway` for Telegram/Discord). `SOUL.md` is global, so install one persona at a time; skills from several packs can coexist. Project-specific rules (paths, commands) belong in a project `AGENTS.md`, not `SOUL.md`.

Skills can also be installed individually with `hermes skills install <path-or-url>`.
