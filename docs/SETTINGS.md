# Settings

All settings live in one file (`settings.json`), and the app (PC and phone) and the CLI read the same one. Every item defaults to `auto` (the app checks your PC and decides). They apply from the next start.

- Location: the environment variable `SYNC_HOME`, or `settings.json` in `%LOCALAPPDATA%\SyncStrata` if it is not set.
- The command is `sync` on Windows and `sync.sh` on Linux (written as `sync` below).
- Read: `sync settings get`   Write: `sync settings set <name> <value|auto>`   Override for one start only: `sync up --<name> <value>`

## Common items

| Name | Values | What it does |
|---|---|---|
| `model` | `auto`, `sync-xs`, `sync-s`, `sync-m` | The model to use. `auto` picks from your RAM (the table in the README) |
| `tail_skip` | `auto`, `4`, `7`, `10` | Uses fewer experts per token (R4, R7, R10). A smaller number is faster and slightly lower in quality. `10` skips none. `auto` gives `7` with 16 GB of VRAM or more, or with 48 GB of RAM or more and 12 GB of VRAM or more, and `4` otherwise |
| `context` | `auto`, `32768`, `65536`, `131072`, `262144` (`32k` and so on also work) | Max context length (tokens). Longer uses more VRAM. `auto` follows your VRAM (table below) |
| `kv_format` | `auto`, `k8v4`, `k8`, `k4` | Quantization of the conversation memory (K/V). k8v4 is the usual; `k4` uses the least VRAM. `auto` follows your VRAM |
| `ram_max_gib` | `auto`, a number | The most RAM (GiB) used to hold the model |
| `vram_reserve_mib` | `auto`, a number | VRAM (MiB) kept free for other apps |
| `models_dir` | `auto`, a path | Where the models are. `auto` is `SYNC_HOME\models` |
| `ram_squeeze` | `auto`, `off` | Memory squeeze. At start, and once each time you switch models, it pushes the RAM used by other apps out of memory and gives the freed RAM to the model (no app is closed). `auto` (default) is on; `off` turns it off. The amount is shown in the start reason |
| `expert_learning` | `on`, `off` | Learns the order of experts from the chats on this PC and saves it. The default is `off`. In a measurement with Sync-S, R4, dsh chats, the learned order was not faster than upstream's order (93.7 vs 96.1 tok/s), so it is not on by default. With `on`, the learned order is saved in `SYNC_HOME\engine-data` |

## Model directory

On the PC, open **Strata settings → Model directory**. Enter an absolute folder path, or choose **Automatic** to use the default (Windows: `SYNC_HOME\models`; Linux: `$XDG_DATA_HOME/SyncStrata/models`, normally `~/.local/share/SyncStrata/models`). This option is unavailable when a fixed catalog overrides the distributed catalog.

Finish or cancel downloads and checks before saving. After saving, choose **Stop everything**, then reopen Sync-Strata; closing the window alone is not enough. Nothing is moved or deleted by the setting change. After restart, models must already be in the new directory in the expected layout or be downloaded there. Chat history is unaffected. If `sessions_dir` is `auto` and would resolve to a different K/V cache location, the previous location is saved explicitly. Set `sessions_dir` back to `auto` separately if you want the cache to follow the new model directory; that does not move existing cache files.

## Desktop startup

In **Strata settings**, uncheck **Start the model automatically when opening the desktop app** to open chat without loading a model. You can also run `sync settings set desktop_auto_start off`. The default is `on` (`auto` resets to that default).

This applies the next time the native desktop app opens its chat window. It does not stop an already-running model or change explicit starts from the model picker or `sync up`.

## Checking the context settings

With `auto`, they follow your VRAM like this (if only one is `auto`, it matches the one you set):

| VRAM | `context` | `kv_format` |
|---|---|---|
| 12 GB or more | 256K | k8v4 |
| 10-11 GB | 128K | k8v4 |
| 8-9 GB | 64K | k4 |

A combination that does not fit in VRAM cannot be chosen in the app or the CLI (the CLI refuses and gives the reason). If a chat grows past this length and VRAM runs out, it slows down, then stops, and the engine is restarted.

In the app you can choose them under "Start settings", then "Context settings". `sync ctx` prints the current setting, the automatic value and the value actually in use. When the started engine reports "VRAM runs out beyond this length", it shows "up to about N tokens for this setting" (longer than that is slow and eventually fails). The length at which dsh starts summarizing a chat is also set at every start from these settings (from 188,416 tokens when the context is 262,144: the smaller of 90% of the context and "context - 65,536 for one reply - 8,192 of margin"). The same value is shown as "where summarizing starts" in the chat screen.

## Hugging Face token

You need it only to download models from a private repository (a read-only token is enough). Enter it in "Hugging Face token" on the "Context settings" screen. It is stored in the app's own folder (`SYNC_HOME\hf`); the app neither uses nor reads your PC-wide Hugging Face login.

## Connection items

| Name | Default | What it does |
|---|---|---|
| `api_port`, `api_host` | `8080`, `127.0.0.1` | Where the API listens. Anything other than `127.0.0.1` needs a key ([API.md](API.md)) |
| `lan_remote` | `off` | Phone connection (`off`, `lan`, `tailscale`). It can be changed only from the PC's screen and the CLI, and takes effect when dsh is restarted ([REMOTE.md](REMOTE.md)) |
| `dsh_port`, `relay_port`, `proxy_port` | `3080`, `3081`, `8081` | Ports of dsh and the relay. If another program already uses a port (`api_port` included), `sync up` picks a free one nearby, saves it here and tells you; it keeps using that port from then on. You can also set them by hand |

## Chat saves

To resume a chat quickly, the engine keeps the chat's K/V in files. One save is about 0.4-0.5 GiB.

| Name | Default | What it does |
|---|---|---|
| `sessions_dir` | `auto` | Where the saves go. `auto` is "SyncStrata-sessions in the parent folder of the models folder" when the models are on a different drive from `SYNC_HOME`, and `SYNC_HOME\engine-sessions` when they are on the same drive |
| `sessions_max_gib` | `auto` | Cap on the total size (GiB). `auto` is the smaller of 20 and 10% of "free space on that drive + the saves" (at least 2). Beyond it, the oldest saves are deleted at start and when stopping (the newest one is kept). When free space is under 10 GiB, no new save is written |

## Chat screen settings

To avoid competing with the engine for CPU and GPU, the chat screen (the app shell) lowers the priority of its own child processes. The shell reads these two directly from `settings.json`, so `sync settings set` cannot change them: write them in `settings.json`, or pass them as a start argument or an environment variable. The order of precedence is argument, then environment variable, then `settings.json`, then the default. They take effect the next time the screen is opened.

| Name | Values | What it does |
|---|---|---|
| `gui_priority` | `cpu-low` (default), `low`, `idle`, `normal` | Priority of the screen's child processes (argument `--gui-priority`, environment variable `SYNC_GUI_PRIORITY`). `cpu-low` lowers only the CPU priority. `low` also lowers the GPU priority (Windows). `idle` sets CPU and GPU to the lowest (the screen may be less smooth). `normal` changes nothing. On Linux, `cpu-low` and `low` give nice +5 and `idle` gives nice +15 (and an I/O priority); the GPU priority is not touched. Other values are treated as `low` |
| `gui_gpu` | `auto` (default), `on`, `off` | Whether the screen is drawn with the GPU (argument `--gpu`, environment variable `SYNC_GUI_GPU`). `off` draws on the CPU. On Linux, `auto` only applies a setting that avoids a white window. Inside WSL, `auto` also draws on the CPU |

## To make it faster

- While it runs, close apps that use a lot of GPU or memory (games, video export, heavy browser pages). `sync doctor` shows which apps are in use and what it recommends.
- Put the models on an NVMe SSD.
