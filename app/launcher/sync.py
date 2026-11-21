#!/usr/bin/env python3
"""Sync の CLI の入口（11/15 夜の試作．本人「GUI と共に CLI のルートも残す．自分のハーネスをつなぐ人向けに API 形式でも簡単に」）．

  sync              （引数なし．sync.cmd のダブルクリック）番号で選ぶ: 始める（品質・速度）／API だけ／止める／状態／調べ
  sync up   [--gui|--no-gui|--api-only] [--open] [--json] [--preset speed|quality] [--model auto|<id>] [--ram-max-gib N]
            [--vram-reserve-mib N] [--context N] [--port 8080] [--host 127.0.0.1]
            [--api-key KEY] [--engine EXE] [--env K=V ...] [--dry]
                    設定ファイル → 引数の順で決め（auto は PC を調べる），エンジンと dsh を起こす．窓は --open のときだけ開く．--api-only は API だけ．
                    --no-gui は dsh は起こすが画面は開かない（スマホから使う人向け）．何も付けなければ GUI まで開く．
  sync down [--engine|--dsh|--all]   止める（既定 --all）．--engine はエンジンだけ（dsh は残る），--dsh は dsh と中継（エンジンと API は残る）．
                    dsh は自分で起こした物だけ止める（この PC の常駐の dsh には触れない）
  sync status [--json]   動いているか．--json は INTERFACE.md の形（engine・dsh・relay・models・settings・first_run）
  sync settings get [--json] ／ sync settings set <名前> <値|auto>   設定（SYNC_HOME の settings.json．次の起動から効く）
  sync gui-url [--json]   窓が開くべき URL（自分で起こした dsh ならログインを通す URL）
  sync remote-url [--json] [--pair] ／ sync remote-apply   スマホの接続（設定 lan_remote）の URL／1 回きりの QR を端末に／今すぐ効かせる（係 R）
  sync status       動いているか，モデル，直近の速さと 1 窓の内訳
  sync api          ほかのハーネスからのつなぎ方（番地・モデル名・curl の例・環境変数）
  sync doctor       PC の状態と勧め（閉じると速くなるもの，pack の勧め，いま CPU・GPU を使っているほかのアプリ）
  sync mem [--json]  いまのメモリの様子（RAM・コミット・VRAM，ほかのアプリの上位，Sync-Strata 自身の分）．画面の「メモリ」の欄の元（11/17 係 W5）
  sync update check [--json] [--local]   落とさずに，新しい版と変わる部品を調べる（画面の「更新」の欄の元．11/18 係 W9）
  sync update apply [--json]             閉じて更新する（切り離した係が，全て閉じる→更新→起こし直す．窓か端末に様子が出る）
  sync chat [--system 文] [--preset speed|quality]
                    端末でそのまま会話する（API に直接．終わるのは空行か Ctrl-C）

API は OpenAI 互換（/v1/chat/completions・/v1/responses・/v1/models）と Anthropic 互換（/v1/messages）．
127.0.0.1 以外で待ち受ける（LAN のほかの PC からつなぐ）ときは鍵が要る: 環境変数 STRATA_API_KEY に入れてから sync up --host 0.0.0.0．
"""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oscompat  # noqa: E402,F401  11/16 S2: Linux では creationflags を外す

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import sync_launch as L  # noqa: E402
import wintune  # noqa: E402
import sync_home as H  # noqa: E402
import sync_i18n  # noqa: E402  11/17 I-10

sync_i18n.set_from_argv(sys.argv)       # --lang en|ja
if "--lang" in sys.argv:                # 下の各コマンドの引数に残さない
    _i = sys.argv.index("--lang")
    del sys.argv[_i:_i + 2]
_print = print


def print(*a, **kw):                    # noqa: A001  11/17 I-10: 英語の画面なら，出す前に英語にする
    _print(*[sync_i18n.t(x) if isinstance(x, str) else x for x in a], **kw)


def print_json(obj, **kw):
    """11/20 0.1.3（GitHub Issue #4）: 機械が読む JSON は翻訳を通さない．英語の画面では上の print が日本語を含む行の頭に
    [ja only] を付けるので，sync status --json が JSON でなくなり，GUI が状態を読めずに終わっていた"""
    _print(json.dumps(obj, ensure_ascii=False), **kw)


def _port(argv):
    return int(argv[argv.index("--port") + 1]) if "--port" in argv else H.effective()["api_port"]      # 11/18 W12: 既定は設定の番号（前は 8080 固定）


def _key():
    return os.environ.get("STRATA_API_KEY", "")


def _get(port, path):
    hdr = {"Authorization": "Bearer " + _key()} if _key() else {}
    return json.loads(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=hdr), timeout=5).read())


def cmd_status(argv):
    if "--json" in argv:
        print_json(status_dict())
        return 0
    port = _port(argv) if "--port" in argv else H.effective()["api_port"]
    L.PORT = port
    if not L.health(port):
        print("止まっています（sync up で起こす）")
        return 1
    try:
        h = _get(port, "/health")
    except Exception:
        h = {}
    print(f"動いています: http://127.0.0.1:{port}  モデル {h.get('model', '?')}  画像 {'可' if h.get('images') else '不可'}  鍵 {'あり' if h.get('api_key') else 'なし'}")
    log = f"{L.ROOT}/strata-auto.log"
    if os.path.exists(log):
        size = os.path.getsize(log)
        d = wintune.diagnose(log, max(0, size - 400_000))
        for line in d.get("findings") or []:
            print("  " + line)
    return 0


def cmd_api(argv):
    port = _port(argv)
    host = argv[argv.index("--host") + 1] if "--host" in argv else "127.0.0.1"
    if not L.health(port):
        print("（いまは止まっています．sync up --api-only で API だけ起こせます）")
    for line in L.api_info(host, port, bool(_key())):
        print(line)
    print("  Python（openai の部品）の例:")
    print(f'    from openai import OpenAI; c = OpenAI(base_url="http://{host}:{port}/v1", api_key="{"<鍵>" if _key() else "x"}")')
    print('    r = c.chat.completions.create(model="strata", messages=[{"role": "user", "content": "こんにちは"}], extra_body={"strata_tune": {"tail_skip": 7}})')
    return 0


def cmd_doctor(argv):
    pack = L.PACKS[0]["dir"] if L.PACKS else None   # 11/15 S2: モデルがまだ無い PC
    d = wintune.preflight(pack, do_ssd="--ssd" in argv)
    if "error" in d:
        print(d["error"])
        return 3
    g = (d.get("gpus") or [{}])[0]
    print(f"RAM {d['ram']['total_gib']} GiB（空き {d['ram'].get('avail_if_stopped_gib') or d['ram']['avail_gib']} GiB）／GPU {g.get('name')}（VRAM の空き {g.get('vram_free_mib')} MiB，画面 {g.get('display_active')}）")
    print(f"勧める pack: {d['recommended_pack']}")
    import sync_env      # 11/15 夜: 対応環境
    ev = sync_env.check()
    for it in ev["blockers"]:
        print(" × " + sync_env.text(it, sync_i18n.lang()))
    for it in ev["warnings"] + ev["notes"]:
        print(" ・" + sync_env.text(it, sync_i18n.lang()))
    for x in d["advice"]:
        print(" ・" + x)
    w = wintune.watch(3)
    for x in w.get("say") or []:
        print(" ・" + x)
    return 0


def cmd_chat(argv):
    port = _port(argv)
    L.PORT = port
    if not L.health(port):
        print("止まっています．先に sync up --api-only（または sync up）")
        return 1
    R = {"speed": 4, "quality": 7}.get(argv[argv.index("--preset") + 1] if "--preset" in argv else "quality", 7)
    if "--tail-skip" in argv:
        R = int(argv[argv.index("--tail-skip") + 1])
    R = H.engine_tail(R)   # 11/15: R10＝省かない＝0
    msgs = []
    if "--system" in argv:
        msgs.append({"role": "system", "content": argv[argv.index("--system") + 1]})
    print("（空行か Ctrl-C で終わり）")
    hdr = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if _key():
        hdr["Authorization"] = "Bearer " + _key()
    while True:
        try:
            u = input(sync_i18n.t("あなた> ")).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not u:
            break
        msgs.append({"role": "user", "content": u})
        body = {"model": "strata", "stream": True, "messages": msgs, "temperature": 0.7, "strata_tune": {"tail_skip": R},
                "stream_options": {"include_usage": True}}
        req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", data=json.dumps(body).encode(), headers=hdr)
        out, tps = [], None
        try:
            with urllib.request.urlopen(req, timeout=1800) as r:
                for raw in r:
                    line = raw.strip()
                    if not line.startswith(b"data:"):
                        continue
                    data = line[5:].strip()
                    if data == b"[DONE]":
                        break
                    try:
                        ch = json.loads(data)
                    except ValueError:
                        continue
                    if ch.get("timings"):
                        tps = ch["timings"].get("predicted_per_second")
                    for c in ch.get("choices") or []:
                        t = (c.get("delta") or {}).get("content")
                        if t:
                            out.append(t)
                            sys.stdout.write(t)
                            sys.stdout.flush()
        except KeyboardInterrupt:
            print("\n（止めました）")
        print(f"\n  [{tps:.1f} tok/s]" if tps else "")
        msgs.append({"role": "assistant", "content": "".join(out)})
    return 0


def _settings():
    return H.effective()


def cmd_down(argv):
    """down [--engine|--dsh|--all]（既定 --all）．dsh は自分で起こした物だけ止める（この PC の常駐の dsh には触れない）"""
    what = "engine" if "--engine" in argv else "dsh" if "--dsh" in argv else "all"
    s = _settings()
    out = {"engine": None, "dsh": None}
    if what in ("engine", "all"):
        code = L.stop_engine(s["api_port"])
        out["engine"] = "stopped" if code == 0 else f"failed ({code})"
        print("エンジンを止めました．" if code == 0 else f"エンジンを止められませんでした（{code}）", file=sys.stderr if "--json" in argv else sys.stdout)
    if what in ("dsh", "all"):
        did = H.stop_dsh(s, say=lambda x: print(x, file=sys.stderr if "--json" in argv else sys.stdout))
        out["dsh"] = did
        print(("止めました: " + "・".join(did)) if did else "止めた dsh はありません（自分で起こした物が無い）", file=sys.stderr if "--json" in argv else sys.stdout)
    if "--json" in argv:
        print_json({"ok": out["engine"] in (None, "stopped"), **out})
    return 0 if out["engine"] in (None, "stopped") else 1


def status_dict():
    s = _settings()
    port = s["api_port"]
    up = L.health(port)
    model = None
    if up:
        try:
            model = (_get(port, "/v1/models").get("data") or [{}])[0].get("id")
        except Exception:
            model = None
    r = None
    try:
        ch = json.load(open(H.path("models-state", "choice.json"), encoding="utf-8"))
        if model and ch.get("model") and ch["model"] in model:
            r = ch.get("r")
    except (OSError, ValueError):
        pass
    ms = H.models_state()
    relay_up = H.listening(s["relay_port"])
    return {
        "engine": {"up": up, "model": model, "r": r, "port": port, "own": H.alive("engine")},
        "dsh": {"up": H.listening(s["dsh_port"]), "port": s["dsh_port"], "own": H.alive("dsh"),
                "proxy": {"up": H.listening(s["proxy_port"]), "port": s["proxy_port"], "own": H.alive("proxy")}},
        "relay": {"up": relay_up, "port": s["relay_port"], "url": f"http://127.0.0.1:{s['relay_port']}/m/", "own": H.alive("relay")},
        "models": {"installed": ms["installed"], "missing_shared": ms["missing_shared"]},
        "settings": H.settings_raw(),
        "spec": H.spec(),
        "first_run": not ms["installed"] or bool(ms["missing_shared"]),
        "home": H.home(),
        "env": __import__("sync_env").check(),   # 11/15 夜: 対応環境（blockers があれば up は起こさない）
        "context": H._sync_ctx.info(H),   # 11/15 係 C: 設定・自動の値・動いているエンジンの値・使える長さ（kv_limit）
    }


def cmd_settings(argv):
    if not argv or argv[0] == "get":
        raw = H.settings_raw()
        if "--json" in argv:
            print_json({"settings": raw, "models_directory": {"path": H._models_dir(), "configurable": H.configurable_catalog()}, "schema": {k: {"help": v[0], "default": v[2]} for k, v in H.SCHEMA.items()},
                        "models": [{"id": m["id"], "name": m.get("name", m["id"])} for m in H.catalog().get("models", [])], "file": os.path.join(H.home(), "settings.json")})
        else:
            for k, (help_, _, dflt) in H.SCHEMA.items():
                print(f"  {k:17s} {str(raw[k]):10s} {help_}")
            print(f"（{os.path.join(H.home(), 'settings.json')}．変えるのは sync settings set <名前> <値|auto>．次の起動から効く）")
        return 0
    if argv[0] == "set" and len(argv) >= 3:
        try:
            old_models_dir = H._models_dir() if argv[1] == "models_dir" else None
            v = H.settings_set(argv[1], argv[2])
        except (KeyError, ValueError, OSError) as e:
            print(str(e).strip("'\""), file=sys.stderr)
            return 2
        if "--json" in argv:
            out = {"ok": True, "name": argv[1], "value": v}
            if old_models_dir is not None:
                out["path_changed"] = os.path.normcase(old_models_dir) != os.path.normcase(H._models_dir())
            print_json(out)
        else:
            print(f"{argv[1]} = {v}（次の起動から効きます）")
        return 0
    print("使い方: sync settings get [--json] ／ sync settings set <名前> <値|auto>")
    return 2


def cmd_gui_url(argv):
    u = H.gui_url(_settings())
    if "--json" in argv:
        print_json({"url": u})
    else:
        print(u)
    return 0


MENU = [("1", "始める（品質重視．会話の画面まで開く）", ["up", "--preset", "quality", "--open"]),
        ("2", "始める（速度重視．会話の画面まで開く）", ["up", "--preset", "speed", "--open"]),
        ("3", "API だけ始める（自分のハーネスをつなぐ人向け）", ["up", "--api-only"]),
        ("4", "止める（エンジンと，自分で起こした dsh）", ["down", "--all"]),
        ("5", "状態を見る（動いているか・直近の速さ）", ["status"]),
        ("6", "PC の調べと勧め", ["doctor"]),
        ("7", "コマンドの使い方", ["help"])]


def menu():
    """引数なし（sync.cmd のダブルクリック）のとき: 番号で選ぶ．選ぶのは「品質か速度か」だけで，残りの設定は PC を調べて決める．"""
    print("Sync: Qwen3.8-Flash-Next をこの PC で動かす（11/15 の試作）")
    for k, label, _ in MENU:
        print(f"  {k}  {label}")
    try:
        c = input(sync_i18n.t("番号を入れて Enter（そのまま Enter は 1）> ")).strip() or "1"
    except (EOFError, KeyboardInterrupt):
        print()
        return 0
    pick = [argv for k, _, argv in MENU if k == c]
    if not pick:
        print("1〜7 の番号を入れてください．")
        rc = 2
    else:
        rc = run(pick[0])
    try:
        input(sync_i18n.t("（Enter でこの窓を閉じます．始めた Strata は動いたままです．止めるのは 4）"))
    except (EOFError, KeyboardInterrupt):
        print()
    return rc


def main():
    argv = sys.argv[1:]
    if not argv:
        return menu()
    return run(argv)


EN_USAGE = """sync up [--gui|--no-gui|--api-only] [--open] [--json] [--preset speed|quality] [--model auto|<id>] [--ram-max-gib N] [--vram-reserve-mib N]
        [--context N] [--port 8080] [--host 127.0.0.1] [--api-key KEY] [--dry]     start the engine (and dsh); auto settings from this PC
sync down [--engine|--dsh|--all]    stop        sync status [--json]    running? model, recent speed
sync settings get|set <name> <value|auto>       sync gui-url    sync api    how to connect other tools    sync doctor    PC check and advice
sync update check [--json] [--local]     look for a new version (downloads nothing)     sync update apply    close, update, start again
sync chat [--system TEXT] [--preset speed|quality]     talk in the terminal (empty line or Ctrl-C ends)
Add --lang en|ja to choose the language (default: English on a text-only console, TERM=linux; or set SYNC_LANG).
The API is OpenAI-compatible (/v1/chat/completions, /v1/responses, /v1/models) and Anthropic-compatible (/v1/messages).
To listen beyond 127.0.0.1, set STRATA_API_KEY first, then: sync up --host 0.0.0.0."""


def _usage():
    print(EN_USAGE if sync_i18n.use_en() else __doc__)


def run(argv):
    if argv[0] in ("-h", "--help", "help"):
        _usage()
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "up":
        return L.main(rest)
    if cmd == "down":
        return cmd_down(rest)
    if cmd == "ctx":   # 11/15 係 C: コンテキストの設定（画面の「コンテキスト設定」が読む）
        return H._sync_ctx.cmd_ctx(rest, H)
    if cmd == "settings":
        return cmd_settings(rest)
    if cmd == "gui-url":
        return cmd_gui_url(rest)
    if cmd in ("remote-url", "remote-apply"):   # 11/15 係 R: スマホの接続
        import sync_remote
        return sync_remote.main(cmd, rest)
    if cmd == "status":
        return cmd_status(rest)
    if cmd == "api":
        return cmd_api(rest)
    if cmd == "env":
        import sync_env
        return sync_env.cmd_env(rest)
    if cmd == "mem":      # 11/17 係 W5: メモリの見える化（JSON 1 行．ASCII だけ）
        import sync_mem
        return sync_mem.main(rest)
    if cmd == "update":   # 11/18 係 W9: 更新を画面から（確かめる・閉じて更新する）
        import sync_update
        return sync_update.main(rest)
    if cmd == "doctor":
        return cmd_doctor(rest)
    if cmd == "chat":
        return cmd_chat(rest)
    _usage()
    return 2


if __name__ == "__main__":
    sys.exit(main())
