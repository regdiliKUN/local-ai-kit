# strata-dsh-workbench

Wire the **Strata inference engine** and the **DeepSeek Harness (dsh) agent** into one
working local AI stack on Windows.

Strata runs a 125B MoE model (128K context, **144–154 tok/s measured**); dsh gives it hands —
file I/O, shell, subagents, workflows. Together you get an AI that never leaves your machine
and can actually touch your files.

> **This repo is** the integration layer: config templates, launchers, a zero-dependency WebUI,
> and notes from real hardware. **It is not** a copy of Strata or dsh — both are separate
> open-source projects you install yourself. No model weights are included either.

**中文文档见 [README.md](README.md)**（更完整，含全部实测数据）。

---

## Architecture

```
You
 ├─ http://127.0.0.1:3080 ─► DeepSeek Harness    (agent: files, shell, subagents, MCP)
 ├─ http://127.0.0.1:8090 ─► Strata WebUI        (chat, folder upload, prompt enhance)
 └─ http://127.0.0.1:8080 ─► Strata engine       (Qwen3.8-Flash-Next 125B MoE)
```

Both front-ends call the same OpenAI-compatible endpoint. dsh can drive Strata; not the reverse.

---

## Features

| | |
|---|---|
| **One-click launch** | A single .bat starts the engine, polls `/health`, then brings up dsh |
| **Path auto-detection** | `setup.bat` probes for Strata / dsh / Node / Python and writes `config/paths.bat` |
| **Live streaming chat** | SSE token-by-token, collapsible reasoning, stop button, first-token and tok/s stats |
| **Folder upload** | Pick or drag a whole directory; recursive walk; auto text detection; context estimate |
| **Prompt enhancement** | Rewrite your draft with the local model. Conservative / aggressive, 1–3 variants, side-by-side diff, undo |
| **Continue** | Resume a truncated answer from the exact break point — not a regenerate |
| **Prompt templates** | 16 built-in templates, inserted ahead of your draft |
| **VRAM doctor** | `tools/fix-vram-reserve.py` measures desktop usage and fixes `--vram-reserve-mib` |
| **Self-check** | `tools/verify.bat` checks paths, engine, models, dsh integration, WebUI |

---

## Requirements

Measured on: RTX 4090 24GB · i9-13900K · 64GB DDR5 · Windows 10 19045 · driver 617.42

| | |
|---|---|
| VRAM | **≥ 16GB**, 24GB recommended |
| RAM | ≥ 32GB, 64GB recommended (experts stay resident in RAM, streamed to GPU over PCIe) |
| Disk | **≥ 120GB free, SSD required** (weights ≈ 68GB; a spinning disk makes prefill unusable) |
| OS | Windows 10 1809+ / 11 (scripts target Windows) |
| Python | 3.10+ |
| Node.js | 18+ |

---

## Quick start

```bat
:: 1. upstream projects
git clone https://github.com/Niko1221/Strata F:\Strata
mkdir C:\Users\%USERNAME%\dsh-runtime && cd C:\Users\%USERNAME%\dsh-runtime
npm install @deepseek-ai/dsh

:: 2. this repo
git clone https://github.com/regdiliKUN/strata-dsh-workbench
cd strata-dsh-workbench

:: 3. configure (auto-detects paths, writes config\paths.bat, optional shortcuts)
setup.bat

:: 4. check everything
tools\verify.bat

:: 5. install engine + weights (~68GB, skip if already done)
tools\install-strata.bat

:: 6. run
launchers\Strata-dsh-Workbench.bat
```

Then in dsh: **Settings → Models** → pick
`Strata Local (Qwen3.8-Flash-Next 125B MoE)`.

> Do **not** pick `qwen3.8:27b` — that is the Ollama model and the launcher starts Strata only.
> Ollama (23.2GB) + Strata (15GB) = 38GB, which cannot fit in 24GB of VRAM.
> The symptom of getting this wrong is `socket stream idle timeout after 300000ms`.

---

## ⚠️ The one hard constraint: VRAM

**This is the single issue that can make the whole setup unusable.**

Strata's `--vram-reserve-mib` defaults to **700 MiB**, which assumes the card is dedicated.
On Windows the desktop alone (browsers, chat apps, Steam, capture tools) holds ~2GB.

When the cache fills the card, WDDM **does not fail** — it silently pages VRAM to system RAM.
Upstream `docs/DETAILS.md`:

> …so the start looks normal, the banner still reports the slot count, and **only the speed collapses**.

Requests then never finish, and the next desktop VRAM demand makes the driver move GPU memory
to RAM — the OS then kills the process.

**Real evidence from this machine:**

```
strata serve: 342 MiB of VRAM free with everything loaded     <- far too low
strata serve: WARNING: only 0 MiB of VRAM free at the start of this request
03:19  RADAR_PRE_LEAK_64  on strata.exe                       <- Windows flags a leak
04:53  python.exe APPCRASH  0xc0000005                        <- process dies
strata generate: memory guard: available 37.0 GiB             <- system RAM was never short
```

**Fix:**

```bat
python tools\fix-vram-reserve.py            :: diagnose only
python tools\fix-vram-reserve.py --apply    :: write (auto-backup)
```

| | Before | After |
|---|---|---|
| VRAM free with everything loaded | **342 MiB** | **2752 MiB** |
| VRAM warnings per request | 4 (down to 0 MiB) | **0** |
| Generation speed | unusable | 53 → 114 tok/s |

Full write-up: [`docs/05-troubleshooting.md`](docs/05-troubleshooting.md) (Chinese).

---

## Layout

```
setup.bat                      step one: detect paths, write config, make shortcuts
config/                        paths.example.bat + resolve.bat (shared detection)
launchers/                     Workbench / WebUI / Start / Stop / Folder-Agent
webui/                         server.py + index.html (stdlib only, no pip deps)
tools/                         installer, progress monitor, verify, VRAM doctor, run wrapper
integrations/dsh/              apply.py (text patcher with backup + rollback) + snippets
docs/                          01 hardware · 02 install · 03 webui · 04 dsh · 05 troubleshooting
```

---

## Third-party

No third-party source is bundled. Install these yourself:

| Project | Role | License |
|---|---|---|
| [Niko1221/Strata](https://github.com/Niko1221/Strata) | C++ inference engine | MIT |
| [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) | Agent platform | MIT |
| Qwen3.8-Flash-Next | Model weights | See upstream |

See [NOTICE.md](NOTICE.md).

## License

Original parts of this repo are **MIT** — see [LICENSE](LICENSE).
