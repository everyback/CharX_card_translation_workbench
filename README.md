# CharX Card Translation Workbench

**CardLoom Translate** is a review-first localization workbench for RisuAI CHARX cards and RISUM modules.

[English](./README.md) | [中文](./README.zh-CN.md)

Are you frustrated by card translators that only translate the opening message, leaving the interface full of foreign text and making the card feel untranslated? If so, you have come to the right place.

This project takes a thorough approach to card translation. It covers lorebooks, protocol fields, and any other visible content it can safely identify, while protecting the structures that must remain intact.

It parses a card before translation, protects executable structure, creates machine-translation drafts, and lets a human approve the final text before export. The workbench runs independently from any chat frontend and never overwrites the original card or chat history.

## Overview

Character cards are structured programs, not plain text files. They can contain lorebooks, Lua, regex rules, variables, asset paths, HTML, and custom protocols. Blindly replacing all text can break buttons, triggers, or runtime behavior.

The workbench separates parsing, scanning, translation, review, and export. Original content remains stored in the project, while only approved text enters the review draft or exported file.

## Supported Formats

CHARX and RISUM are the primary development and test targets. JSON and PNG retain basic compatibility, but their coverage is not equivalent to the CHARX/RISUM path. Always keep the original file and verify imports and exports in the target client.

| Format | Import | Export | Status |
| --- | --- | --- | --- |
| CHARX | Yes | Yes | Primary target; ZIP containers, JPEG+ZIP hybrids, and embedded modules. |
| RISUM | Yes | Yes | Primary target; RisuAI module JSON and resource containers. |
| JSON | Basic | Basic | Character-card and module JSON, with limited fixture coverage. |
| PNG | Basic | Basic | Embedded character-card data, with limited Tavern-card coverage. |

## Features

| Capability | Description |
| --- | --- |
| Multi-format import/export | CHARX and RISUM first, with basic JSON and PNG compatibility. |
| Selectable translation scopes | Character fields, lorebooks, greetings, script UI, Lua prompts, and visible resource JSON. |
| Independent job scheduler | Configurable concurrency, batches, retries, and per-job retry. |
| Human review | Compare source, machine translation, and final text side by side before approval. |
| Structure protection | Protect variables, Lua, regex, protocol shells, paths, URLs, IDs, asset names, and button triggers by default. |
| Lorebook-safe aliases | Preserve original triggers and append approved target-language aliases instead of replacing them. |
| Resource workbench | Inspect media and JSON references; route images through OCR or an image-editing model when needed. |

## Interface

- **Overview**: detected format, lorebooks, scripts, protocols, and resources.
- **Fields**: translatable text grouped by path and protection state.
- **Jobs**: translation progress, batches, errors, and retries.
- **Review**: source, machine output, final text, flags, and bulk approval.
- **Resources**: media references and visible JSON text candidates.
- **Protocols**: Lua, regex, and custom protocol references that need review.

## Fastest Start: Download a Release

If you only want to use the workbench, you do not need Node.js, Docker, or a local build: open [GitHub Releases](https://github.com/everyback/CharX_card_translation_workbench/releases) and download a Windows desktop build.

- **Installer**: run the setup EXE and follow the installation wizard.
- **Portable**: run the portable EXE directly; application data stays in the `data/` folder next to the EXE, so it can be kept in any folder or on a removable drive.

`CardLoom Translate Nightly` is updated automatically from the latest `master` commit and is the quickest way to get the newest build. For a formal version, choose a `v`-prefixed release from [Tags](https://github.com/everyback/CharX_card_translation_workbench/tags). After downloading, start the application, open the local address it displays, and configure the model endpoint and API key in **Model Settings**.

## Quick Start

Docker Compose is the recommended deployment method.

Requirements:

- Windows: Docker Desktop and Docker Compose v2.
- Linux: Docker Engine and Docker Compose v2.
- An OpenAI Chat Completions-compatible model endpoint.

### 1. Optional local configuration

PowerShell:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

Linux:

```bash
[ -f .env ] || cp .env.example .env
nano .env
```

The first run can use the defaults. Open the UI, choose **Model Settings**, and enter the API base URL, model, API key, source language, target language, concurrency, and batch size. Image localization uses a separate optional image-editing model.

Model settings are stored by the backend in local SQLite. The browser only receives a configured/not-configured status.

### 2. Build and start

```bash
docker compose -f docker/compose.yml up -d --build
```

The default address is [http://127.0.0.1:8787/](http://127.0.0.1:8787/). Compose binds the host port to loopback by default.

### 3. Verify

PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
docker compose -f docker/compose.yml ps
```

Linux:

```bash
curl --fail --silent --show-error http://127.0.0.1:8787/api/health
docker compose -f docker/compose.yml ps
```

The health endpoint should return `ok: true`.

## First Use

1. Open **Model Settings** and configure the model endpoint, model name, API key, source language, target language, concurrency, and batch size.
2. Import a CHARX, RISUM, PNG, or JSON file, or drop it onto the page.
3. Check **Overview** and confirm the detected card, lorebook, script, protocol, and resource counts.
4. Choose a translation scope. **Translate all visible content** includes card text, lorebooks, Lua prompts, script UI, and visible resource JSON.
5. Start translation and inspect progress and failures on **Jobs**.
6. Review machine output against the source. Approve items individually or in batches.
7. Generate the review draft, then export JSON, PNG, CHARX, or RISUM.

The original import remains available in the project. Machine output is only a draft until it is approved.

PNG and basic JSON currently provide baseline import/export support; CHARX and RISUM are the primary supported formats. After export, verify the character fields, lorebook triggers, scripts, and asset references in the target client.

## Recommended Workflow

1. Configure the model.
2. Import the original card and confirm that its format and counts are correct.
3. Scan fields before starting translation.
4. Start with a conservative concurrency and batch size for large cards.
5. Review protocol, script, button, Lua, and lorebook-trigger entries first.
6. Approve only text that is safe to export.
7. Export and reopen the result in the real client.

Do not judge export safety by fluency alone. For unfamiliar protocols, inspect the **Protocols** and **References** views before approving text used by code.

## Translation Scopes and Protection

| Scope | Includes |
| --- | --- |
| Character fields only | Name, description, personality, scenario, and related core fields. |
| Character + lorebook + greetings | Core fields, lorebook prose, and opening messages. |
| Script UI | Explicitly visible labels, buttons, and dialog text. |
| All visible content | Card, lorebook, script UI, and visible Lua prompts. |
| Translate all | All visible content plus visible strings in embedded CHARX JSON. |
| Parsed Lua strings only | Strings identified as visible text by the Lua parser. |

By default, the workbench does not rewrite variable names, IDs, paths, URLs, regex patterns, Lua structure, protocol shells, or button triggers. Lorebook source keys are preserved; approved target-language aliases are appended to existing key arrays. Protection is an aid, not a replacement for human review.

## Docker Operations

Stop while keeping data:

```bash
docker compose -f docker/compose.yml down
```

Rebuild and start:

```bash
docker compose -f docker/compose.yml up -d --build
```

View logs:

```bash
docker compose -f docker/compose.yml logs --tail=200
```

If port `8787` is occupied, set another loopback port in `.env`:

```dotenv
WORKBENCH_BIND_PORT=18880
```

Then restart the compose project and open `http://127.0.0.1:18880/`. Do not expose the service on `0.0.0.0` without adding trusted authentication, TLS, and access controls.

See [deployment notes](./docs/部署说明.md) for backup and recovery details.

## Technology

- Frontend: React, TypeScript, Vite, and Lucide.
- Backend: TypeScript, Fastify, and SQLite workers.
- Model interface: OpenAI Chat Completions-compatible service.
- Deployment: Docker Compose or a local Node.js process.

## Local Development

Node.js 22 or newer is required:

```bash
npm ci
npm test
npm run build
npm run dev
```

The development UI defaults to `http://127.0.0.1:5173/`; the development API defaults to `http://127.0.0.1:8787/`.

For a production build:

```bash
npm run build
npm start
```

### Windows Desktop Builds

Run these commands on Windows:

```powershell
# Portable EXE: release/CardLoom-Translate-Portable-<version>.exe
npm run desktop:portable

# Installer: release/CardLoom-Translate-Setup-<version>.exe
npm run desktop:installer

# Build both variants
npm run desktop:all
```

The portable build stores SQLite data, uploads, and caches in `data/` next to the EXE. The installer build stores them in Electron's Windows user-data directory. Both variants bind the local service to `127.0.0.1` only.

After a GitHub push, `.github/workflows/desktop-release.yml` builds both EXEs and uploads them to the Actions run. A normal push to `master` automatically updates the downloadable `CardLoom Translate Nightly` prerelease. Pushing a `v`-prefixed tag (for example, `v0.1.0`) creates a separate formal GitHub Release with the installer assets.

The current Actions artifacts are unsigned because no Windows code-signing certificate secret is configured. Windows may show an “Unknown publisher” warning on first launch; this does not prevent the application from running.

## Configuration

Deployment settings live in `.env`. The API base URL, model, API key, languages, concurrency, batch sizes, and image settings can only be configured from **Model Settings** in the UI. `TRANSLATION_*` and `IMAGE_EDIT_*` environment variables are not supported, and no model settings are written from `.env` into SQLite. Settings saved from the UI are stored in local SQLite. API keys are read by the backend and must not be committed to Git.

### Recommended Initial Settings

The following values were read from the current SQLite configuration as a reference for the UI. The API key is shown only as configured/not configured. Enter these values in **Model Settings**, not in `.env`:

| UI setting | Current reference |
| --- | --- |
| API base URL | `https://opencode.ai/zen/go/v1` |
| API key | Configured (not displayed) |
| Model | `deepseek-v4-flash` |
| Source language | `auto` |
| Fallback language | `en` |
| Target language | `zh-CN` |
| Concurrency | `400` |
| Items per batch | `40` |
| Characters per batch | `600000` |
| Image-editing API, key, and model | Not configured |

| Variable | Purpose | Default |
| --- | --- | --- |
| `WORKBENCH_HOST` | Local Node.js bind address | `127.0.0.1` |
| `WORKBENCH_PORT` | Internal application port | `8787` |
| `WORKBENCH_BIND_PORT` | Docker host port | `8787` |
| `WORKBENCH_UPLOAD_LIMIT_MB` | Per-file upload limit; `0` means no extra limit | `0` |
| `WORKBENCH_DB_WORKERS` | SQLite worker count | `3` |

Higher concurrency and larger batches increase memory use, model cost, and rate-limit risk. The table above records the current configuration as a reference; it is not a universal recommendation for every card or provider.

## Data and Security

- Local Node.js stores SQLite data, uploads, drafts, and caches under `data/`; Docker uses named Compose volumes.
- `.env`, SQLite files, volumes, logs, backups, and imported cards may contain secrets or private content. Do not commit them.
- There is no login system. The default loopback binding is intended for local single-user use.
- Back up important projects before upgrades, deployment changes, bulk export, or cleanup. `docker compose down -v` removes Compose volumes.
- Recheck Lua, regex, protocols, lorebook triggers, and asset references before exporting an unfamiliar card.

## Contributing

Issues with a redacted log and a minimal reproduction are especially useful. Before submitting code:

1. Keep model keys, imported cards, SQLite data, backups, and logs out of commits.
2. Add regression tests for parser, protection, export, or scheduler changes.
3. Run `npm test` and `npm run build`.
4. Follow the repository rules in [AGENTS.md](./AGENTS.md).

## License

This project is released under the [GNU GPL v3.0 or later](./LICENSE). Copying, modifying, and redistributing the project must comply with the license and its corresponding-source requirements.
