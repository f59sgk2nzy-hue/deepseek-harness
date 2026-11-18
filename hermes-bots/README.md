# Hermes bot packs

Copy-ready personas and skills for [Hermes Agent](https://hermes-agent.nousresearch.com/docs/). Each pack is a `SOUL.md` (identity, slot #1 of the system prompt), a `config.snippet.yaml`, and SKILL.md skills in the Hermes layout (`~/.hermes/skills/<category>/<name>/SKILL.md`).

| Pack | Purpose |
|-|-|
| `engineer` | Coding bot: verify-before-done, TDD loop, PR workflow |
| `researcher` | Source-grounded research and decision briefs |
| `operator` | Cautious ops/automation with approval and rollback discipline |
| `apac-sourcing` | International sourcing analyst for Asia-Pacific vendors: intake, discovery, OEM identification, competitor/customer supplier mapping, competitive-advantage plans, due diligence, trade-compliance screen, material equivalence, landed cost, RFQ drafts, scorecard, qualification plan. Advisory only: drafts, never contacts vendors |
| `bot-creator` | Skill that generates new packs from a short brief |

## Install

```sh
./install.sh engineer --dry-run   # preview
./install.sh engineer             # installs to $HERMES_HOME or ~/.hermes, backing up existing files
```

Then merge the pack's `config.snippet.yaml` into `~/.hermes/config.yaml` and restart (`hermes gateway` for Telegram/Discord). `SOUL.md` is global, so install one persona at a time; skills from several packs can coexist. Project-specific rules (paths, commands) belong in a project `AGENTS.md`, not `SOUL.md`.

Skills can also be installed individually with `hermes skills install <path-or-url>`.

## Install on a VPS as its own profile

A Hermes profile is a separate agent (own `SOUL.md`, skills, memory, bot token) under `~/.hermes/profiles/<name>`, so a pack can run beside an existing bot without replacing its persona. Run on the VPS as the user that runs Hermes:

```sh
# 1. Get the packs (git clone, or upload hermes-bots.tar.gz with scp and extract it)
git clone --depth 1 -b claude/loving-fermat-xx0k2w https://github.com/f59sgk2nzy-hue/deepseek-harness.git dsh
cd dsh/hermes-bots

# 2. Create the profile and install the pack into it
hermes profile create apac-sourcing
hermes profile show apac-sourcing            # confirm the home path
HERMES_HOME="$HOME/.hermes/profiles/apac-sourcing" ./install.sh apac-sourcing

# 3. Pick the model, enable web + terminal tools, and add this bot's own Telegram/Discord token
hermes -p apac-sourcing setup

# 4. Auto-load skills (if config.yaml already has a top-level `skills:` key, merge by hand instead)
grep -q '^skills:' "$HOME/.hermes/profiles/apac-sourcing/config.yaml" || cat packs/apac-sourcing/config.snippet.yaml >> "$HOME/.hermes/profiles/apac-sourcing/config.yaml"

# 5. Fill in the company profile, then run the gateway as a service
nano "$HOME/.hermes/profiles/apac-sourcing/skills/sourcing/sourcing-intake/references/company-profile.md"
hermes -p apac-sourcing doctor
hermes -p apac-sourcing gateway install
```

To update later: `git pull` in `dsh/`, rerun step 2's `install.sh` line (the filled company profile is kept), and restart the profile's gateway.
