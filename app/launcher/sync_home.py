#!/usr/bin/env python3
"""起動の道具の土台（11/15 app1115．INTERFACE.md の 3・4）: 設定ファイル，置き場，モデルの一覧，起こしたプロセスの記録，dsh の起こし方．

- SYNC_HOME（環境変数．無ければ %LOCALAPPDATA%\\SyncStrata）の下:
    settings.json   設定（どの項目も値か "auto"．既定は全部 auto）
    run\\            起こしたプロセスの記録（procs.json），dsh のログイン用 URL（dsh-url.json．この利用者だけが読める）
    logs\\           dsh・中継・会話の中継・エンジンの記録（トークンは書かない）
    dsh-home\\       自分で起こす dsh の DSH_HOME（設定 dsh_home で替えられる）
    sessions\\       会話の中継（session-proxy）の控えの置き場
- 部品の置き場（11/15 S2: 自分の位置から並びを見る．layout()）:
    1. 環境変数 SYNC_DSH_ROOT・SYNC_RELAY_JS・SYNC_PROXY_JS・SYNC_CATALOG・SYNC_NODE・SYNC_DSH_PROFILE（あればいちばん先）．
    2. 入れた先の並び: この道具が <app>\\launcher\\ にあり，隣に engine\\bin\\strata.exe か chat\\server.mjs があるとき，
       <app>\\engine・python・node・dsh・chat・pack\\dsh-profile を使う．モデルの一覧は chat\\models\\models.dist.json（道のりは
       設定 models_dir からの相対）を SYNC_HOME\\models-state\\catalogs に絶対の道のりで書き出して使う（中継にも同じ物を渡す）．
    3. どちらでもなければ，同じフォルダーの layout.dev.json（作者の PC の作業場の並び．配布物には入らない）．
- 止めるのは，ここで起こして procs.json に残したプロセスだけ（番号と生まれた時刻の両方が合うとき）．この PC の常駐の dsh（タスク DshAutoStart）には触れない．
"""
import ctypes, hashlib, json, os, re, shutil, socket, subprocess, sys, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import oscompat as OS  # noqa: E402  11/16 S2: Windows と Linux の違い（Linux では creationflags を外す）
X = OS.EXE
GIB = 1024 ** 3


def home():
    h = os.environ.get("SYNC_HOME") or OS.default_home()
    os.makedirs(h, exist_ok=True)
    return h


def path(*p):
    d = os.path.join(home(), *p)
    os.makedirs(os.path.dirname(d), exist_ok=True)
    return d


APP = os.path.dirname(HERE)


def _installed():
    """入れた先の並び（<app>\\launcher\\ とその隣の部品）か"""
    return os.path.basename(HERE).lower() == "launcher" and (
        os.path.isfile(os.path.join(APP, "chat", "server.mjs")) or os.path.isdir(os.path.join(APP, "engine", "serve"))
        or any(os.path.isfile(os.path.join(APP, d, "bin", "strata" + X)) for d in os.listdir(APP) if d.startswith("engine")))


def _layout():
    """部品の置き場（INSTALLED なら入れた先，そうでなければ layout.dev.json）．値は絶対の道のりか None"""
    if _installed():
        j = lambda *p: os.path.join(APP, *p)
        prof = j("engine", "data", "expert-profile-upstream.bin")
        rv = j("engine", "data", "Qwen3.8-Flash-Next-experimental-speed-projection.gguf")
        # 11/15 夜: エンジンは世代ごとの部品 engine-<種類>（cuda13・cuda12・hip-*）．この PC の GPU に合う物（sync_env）を使う．
        # 無ければ前の並び（enginein）
        try:
            import sync_env
            kind = sync_env.check()["engine"]
        except Exception:
            kind = None
        bin_ = j(f"engine-{kind}", "bin") if kind and os.path.isfile(j(f"engine-{kind}", "bin", "strata" + X)) else j("engine", "bin")
        vis = os.path.join(bin_, "strata-vision" + X)
        py = j("python", "python.exe") if OS.IS_WIN else j("python", "bin", "python3")     # Linux の同梱の Python は python-build-standalone の並び
        return {"kind": "installed", "python": py, "server_py": j("engine", "serve", "serve", "server.py"),
                "engine_exe": os.path.join(bin_, "strata" + X),
                "engine_lib_dirs": [bin_] + [d for d in (os.path.join(bin_, "rocm", "bin"),) if os.path.isdir(d)],   # HIP: ROCm の DLL と GEMM のカーネル "engine_cwd": j("engine"), "engine_kind": kind,
                "engine_template": os.path.join(HERE, "engine-template.json"), "expert_profile": prof if os.path.isfile(prof) else None,
                "refusal_vector": rv if os.path.isfile(rv) else None,   # 11/20 0.1.3: 拒否を減らす制御ベクトル（engine\data）
                "slot_save_path": None, "stop_ps1": None, "dsh_root": j("dsh"), "node": j("node", "dsh-node" + X),
                "dsh_profile": j("pack", "dsh-profile"), "relay_js": j("chat", "server.mjs"), "proxy_js": j("chat", "session-proxy.mjs"),
                "catalog": None, "catalog_dist": j("chat", "models", "models.dist.json"), "daily_choice": None, "packs_extra": [],
                "vision_exe": vis if os.path.isfile(vis) else None}
    try:
        d = json.load(open(os.path.join(HERE, "layout.dev.json"), encoding="utf-8"))
    except (OSError, ValueError):
        d = {}
    out = {"kind": "dev" if d else "none", "packs_extra": d.get("packs_extra") or []}
    for k in ("python", "server_py", "engine_exe", "engine_template", "slot_save_path", "stop_ps1", "dsh_root", "node", "dsh_profile",
              "relay_js", "proxy_js", "catalog", "catalog_dist", "daily_choice", "expert_profile", "engine_cwd", "refusal_vector"):
        out[k] = os.path.normpath(d[k]) if d.get(k) else None
    out["engine_lib_dirs"] = [os.path.normpath(x) for x in d.get("engine_lib_dirs") or []] or None
    return out


LAYOUT = _layout()
DSH_ROOT = os.environ.get("SYNC_DSH_ROOT") or LAYOUT["dsh_root"] or os.path.join(APP, "dsh")
RELAY_JS = os.environ.get("SYNC_RELAY_JS") or LAYOUT["relay_js"] or os.path.join(DSH_ROOT, "mobile", "server.mjs")
PROXY_JS = os.environ.get("SYNC_PROXY_JS") or LAYOUT["proxy_js"] or os.path.join(os.path.dirname(RELAY_JS), "session-proxy.mjs")
DSH_BIN = os.path.join(DSH_ROOT, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
# 自分で起こす dsh の設定の元（profiles\\web の 4 つ）．会話の中継の番地と文脈の長さだけ合わせて dsh_home に写す
DSH_PROFILE_SRC = os.environ.get("SYNC_DSH_PROFILE") or LAYOUT["dsh_profile"] or os.path.join(DSH_ROOT, "home", "profiles", "web")
DSH_PROFILE_FILES = ["cordis.yml", "cordis.patch.yml", "package.json", "pnpm-workspace.yaml"]


def node_exe():
    n = os.environ.get("SYNC_NODE") or LAYOUT["node"] or os.path.join(DSH_ROOT, "bin", "dsh-node" + X)
    return n if os.path.exists(n) else (shutil.which("node") or "node")


# ------------------------------------------------------------------ 設定（INTERFACE.md の 4）
# 名前 → (説明, 値の検め方, auto のときの値（None は「PC を調べて決める」）)
def _num(lo, hi, integer=False):
    def f(v):
        x = int(v) if integer else float(v)
        if not lo <= x <= hi:
            raise ValueError(f"{lo}〜{hi} の数")
        return x
    return f


def _choice(*cs):
    def f(v):
        if v not in cs:
            raise ValueError("・".join(cs) + " のどれか")
        return v
    return f


def _tail(v):
    x = int(v)
    if x not in (4, 7, 10):
        raise ValueError("4・7・10 のどれか（10＝省かない）")
    return x


def _model(v):
    ids = [m["id"] for m in catalog().get("models", [])]
    if ids and v not in ids:
        raise ValueError("一覧のモデル（" + "・".join(ids) + "）")
    return v


SCHEMA = {
    "model":            ("使うモデル（auto: PC を調べて，全部 RAM に載るいちばん大きいもの）", _model, None),
    "preset":           ("品質重視 quality（R7）か速度重視 speed（R4）．tail_skip の別名（tail_skip が auto のときだけ見る）", _choice("quality", "speed"), None),
    # 11/15 本人: 起動時の tail skip は R4・R7・R10（R10＝省かない．エンジンへは 0）．API を別のソフトから使うときだけ効く
    "tail_skip":        ("起動時の tail skip 4・7・10（10＝省かない．auto: PC のスペックで推奨の方．API を別のソフトから使うときだけ効く）", lambda v: _tail(v), None),
    "ram_max_gib":      ("RAM の写しの最大の枠 GiB（auto: 空き RAM から決める）", _num(1, 512), None),
    "vram_reserve_mib": ("ほかのアプリのために空けておく VRAM MiB（auto: 画面をつないでいれば 1024，いなければ 512）", _num(0, 16384, True), None),
    # 11/16 係 S4: 起動と，画面からのモデルの切り替えのときに 1 回だけ，ほかのアプリの RAM を追い出して（アプリは閉じない），空いた分を専門家の RAM に回す
    "ram_squeeze":      ("起動・モデルの切り替えのとき，ほかのアプリの RAM を追い出して専門家に回す auto（既定．入）か off", _choice("auto", "off"), "auto"),
    # 11/16: 専門家の並びをこの PC の会話で学習して保存する．測り（Sync-S R4 の dsh の会話）で学習した並びは本家の並びより速くならなかった
    # （93.7 対 96.1 tok/s）ので既定は off（本人の決まり: decode を遅くしない．速くならない物は既定で入れない）
    # 11/20 0.1.3（本人の決定）: 拒否を減らす（無検閲・試験的）．本家 Strata の Experimental speed projection と同じ制御ベクトル
    # （refusal-direction projection．層 4〜44 で h -= (h·v) v）を起動時に読み込む．既定は off．on のときだけ decode が少し遅くなる
    "refusal_reduction": ("拒否を減らす（無検閲・試験的）on か off（既定）．書かせた内容は使う人の責任", _choice("on", "off"), "off"),
    "expert_learning":  ("専門家の並びをこの PC の会話で学習して保存する on か off（既定）", _choice("on", "off"), "off"),
    "context":          ("文脈の長さ（トークン．auto: 262144）", _num(4096, 1048576, True), 262144),
    "api_port":         ("エンジン（API）の待ち受けの番号", _num(1, 65535, True), 8080),
    "api_host":         ("エンジンの待ち受けの番地（127.0.0.1 以外は鍵が要る）", str, "127.0.0.1"),
    "lan_remote":       ("スマホの接続 off・lan（同じ Wi-Fi）・tailscale", _choice("off", "lan", "tailscale"), "off"),
    # 11/15 app1115 で足した項目（INTERFACE.md の 4 の形に合わせた）
    "dsh_port":         ("dsh web の待ち受けの番号", _num(1, 65535, True), 3080),
    "relay_port":       ("会話の画面（中継）の待ち受けの番号", _num(1, 65535, True), 3081),
    "proxy_port":       ("会話の中継（session-proxy）の待ち受けの番号", _num(1, 65535, True), 8081),
    "dsh_home":         ("自分で起こす dsh の DSH_HOME（auto: SYNC_HOME\\dsh-home）", str, None),
    # 11/15 S2: 配布物の setup が書く項目（係 P）．消さずに持ち回る
    "models_dir":       ("モデルの置き場（auto: SYNC_HOME\\models．setup が見つけた置き場を書く）", str, None),
    "update_feed":      ("更新の置き場（フォルダーか URL．auto: 配布物の一覧の値）", str, None),
    # 11/16: 会話の控え（K/V の保存）．大きいので，既定はモデルと同じドライブ．合計に上限（超えたら古い物から消す）
    "sessions_dir":     ("会話の控えの置き場（auto: モデルの置き場と同じドライブの SyncStrata-sessions．モデルが既定の置き場なら SYNC_HOME\\engine-sessions）", str, None),
    "desktop_auto_start": ("デスクトップアプリを開くときにエンジンを自動で起こす on（既定）か off", _choice("on", "off"), "on"),
    # 11/17: 会話の窓（Tauri の枠）の描き方．枠が settings.json を直接読む（引数 --gpu・環境変数 SYNC_GUI_GPU が先）．次に窓を開くときから効く
    "gui_gpu":          ("会話の窓を GPU で描くか．auto（既定．Linux は白い窓を避ける設定だけ）・on・off（CPU で描く．decode と GPU を取り合わない．CPU は増える）", _choice("auto", "on", "off"), "auto"),
    "sessions_max_gib": ("会話の控えの合計の上限 GiB（auto: 20 と，そのドライブの空き＋控えの 1 割の小さい方．最低 2）", _num(1, 4096), None),
}


def _settings_file():
    p = os.path.join(home(), "settings.json")
    try:
        with open(p, encoding="utf-8-sig") as f:      # 11/15 S2: BOM つきでも読む（手で書いた設定）
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def settings_raw():
    d = _settings_file()
    return {k: d.get(k, "auto") for k in SCHEMA}


def settings_set(name, value):
    if name not in SCHEMA:
        raise KeyError(f"そういう設定はありません: {name}（あるのは {', '.join(SCHEMA)}）")
    d = _settings_file()      # 11/15 S2: 知らない項目（ほかの係が足した物）も消さずに書き戻す
    for k in SCHEMA:
        d.setdefault(k, "auto")
    if value in (None, "", "auto"):
        d[name] = "auto"
    else:
        try:
            d[name] = SCHEMA[name][1](value)
        except ValueError as e:
            raise ValueError(f"{name} は {e}") from None
    if name == "models_dir":
        v = d[name]
        if v != "auto":
            if (not os.path.isabs(v) or (OS.IS_WIN and not os.path.splitdrive(v)[0])
                    or any(ord(c) < 32 for c in v)):
                raise ValueError("Model directory must be an absolute folder path")
            if os.path.lexists(v) and not os.path.isdir(v):
                raise ValueError("Model directory is not a folder")
            d[name] = os.path.normpath(v)
        if d["sessions_dir"] in (None, "", "auto"):
            old = sessions_dir_auto(_models_dir())
            new = sessions_dir_auto(None if v == "auto" else d[name])
            if os.path.normcase(old) != os.path.normcase(new):
                d["sessions_dir"] = old
    p = os.path.join(home(), "settings.json")
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)
    return d[name]


def effective(overrides=None):
    """設定ファイル → 引数の上書きの順．auto で PC を調べる項目は None のまま返す（sync_launch.choose が決める）"""
    d = settings_raw()
    for k, v in (overrides or {}).items():
        if v is not None:
            d[k] = v if v == "auto" else SCHEMA[k][1](v)
    out = {}
    for k, (_, _, dflt) in SCHEMA.items():
        out[k] = dflt if d[k] == "auto" else d[k]
    if not out["dsh_home"]:
        out["dsh_home"] = os.path.join(home(), "dsh-home")
    if not out["models_dir"]:
        out["models_dir"] = OS.default_models_dir(home())
    if not out["sessions_dir"]:
        out["sessions_dir"] = sessions_dir_auto(out["models_dir"])
    return out


# ------------------------------------------------------------------ 11/16: 会話の控え（K/V の保存）の置き場と上限
SESSIONS_CAP_GIB = 20.0        # 上限の頭打ち（控え 1 つは 0.4〜0.5 GiB＝本人の 1 時間で 7 個 3.05 GB．20 GiB で 40 会話ほど．中継の 16 個の上限が先に効く）
SESSIONS_CAP_FRAC = 0.10       # そのドライブの（空き＋控え）の 1 割まで
SESSIONS_CAP_MIN = 2.0         # 小さいドライブでも 4 会話ほどは残す
LOW_FREE_GIB = 10.0            # ドライブの空きがこれ未満なら新しい控えは書かない（中継の MIN_SAVE_TOKENS を上げる）


def sessions_dir_auto(models_dir):
    """モデルの置き場が既定（SYNC_HOME と同じドライブ）なら SYNC_HOME\\engine-sessions，別のドライブなら その親の SyncStrata-sessions"""
    md = os.path.abspath(models_dir or OS.default_models_dir(home()))
    if os.path.splitdrive(md)[0].lower() == os.path.splitdrive(home())[0].lower() or md == os.path.abspath(OS.default_models_dir(home())):
        return os.path.join(home(), "engine-sessions")
    return os.path.join(os.path.dirname(md.rstrip("\\/")), "SyncStrata-sessions")


def _sessions_files(d):
    out = []
    try:
        for f in os.listdir(d):
            p = os.path.join(d, f)
            if os.path.isfile(p) and f != "index.json" and not f.endswith(".tmp"):
                st = os.stat(p)
                out.append((st.st_mtime, st.st_size, p))
    except OSError:
        pass
    return sorted(out)


def sessions_plan(s):
    """(置き場, 上限 GiB, 空きが少ないか)"""
    d = s["sessions_dir"]
    os.makedirs(d, exist_ok=True)
    used = sum(x[1] for x in _sessions_files(d)) / GIB
    free = shutil.disk_usage(d).free / GIB
    cap = float(s.get("sessions_max_gib") or max(SESSIONS_CAP_MIN, min(SESSIONS_CAP_GIB, (free + used) * SESSIONS_CAP_FRAC)))
    return d, cap, free < LOW_FREE_GIB


def prune_sessions(s, say=print, keep_newest=1):
    """控えの合計が上限を超えていたら古い物（最後に書いた時刻の古い順）から消す．いちばん新しい keep_newest 個は残す
    （エンジンが今使っている会話の控え．中継は index.json で使った順を持つが，止まっている間は書いた時刻で見る）．
    ドライブの空きが少なければ上限を 0 にする（新しい物だけ残す）．中継の index.json は，中継が起きたときに無いファイルを外す"""
    d, cap, low = sessions_plan(s)
    files = _sessions_files(d)
    if low:
        cap = 0.0
    total = sum(x[1] for x in files)
    removed = 0
    for mt, size, p in files[:max(0, len(files) - keep_newest)]:
        if total / GIB <= cap:
            break
        try:
            os.remove(p)
            total -= size
            removed += 1
        except OSError:
            pass
    if removed:
        say(f"  会話の控えを {removed} 個消しました（上限 {cap:.1f} GiB．残り {total / GIB:.1f} GiB．{d}）")
    return removed


# ------------------------------------------------------------------ 11/15: PC のスペックと推奨の tail skip
def spec():
    """RAM・VRAM・GPU・CPU．決め方は中継（server.mjs の /m/spec）と同じ控えの決まり（decode の見積もりの式がまだ無いため）:
    VRAM 16 GB 以上，または RAM 48 GB 以上かつ VRAM 12 GB 以上なら R7，ほかは R4（本人の PC＝3080 12 GB・RAM 32 GB は R4）"""
    ram = round(OS.mem_gib()[0], 1)
    gpu, vram = None, 0.0
    try:
        o = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True,
                           timeout=8, creationflags=0x08000000).stdout
        rows = [[x.strip() for x in l.split(",")] for l in o.strip().splitlines() if "," in l]
        if rows:
            best = max(rows, key=lambda r: float(r[1]))
            gpu, vram = best[0], round(float(best[1]) / 1024, 1)
            if len(rows) > 1:     # 11/19 0.1.2: GPU が複数のときは，起動の道具が使う GPU（sync_env の選び）の値で勧める
                import sync_env
                g = sync_env.check()["gpu"]
                if g.get("vendor") == "nvidia" and g.get("name"):
                    gpu, vram = g["name"], float(g.get("vram_gib") or vram)
    except Exception:
        pass
    if not gpu:      # 11/16 S2: Radeon（nvidia-smi が無い）は対応環境の調べの値
        try:
            import sync_env
            g = sync_env.check()["gpu"]
            gpu, vram = g.get("name") or None, float(g.get("vram_gib") or 0)
        except Exception:
            pass
    try:
        ov = json.loads(os.environ.get("DSH_SPEC_OVERRIDE") or "{}")
        ram, vram, gpu = ov.get("ram_gib", ram), ov.get("vram_gib", vram), ov.get("gpu", gpu)
    except ValueError:
        pass
    high = vram + 0.5 >= 16 or (ram + 1 >= 48 and vram + 0.5 >= 12)
    return {"ram_gib": ram, "vram_gib": vram, "gpu": gpu, "threads": os.cpu_count(), "recommended_r": 7 if high else 4,
            "reason": f"この PC は VRAM {vram} GiB・RAM {ram} GiB なので R{7 if high else 4} を勧めます"}


def engine_tail(r):
    """画面・設定の R（4・7・10）→ エンジンの値（10＝省かない＝0）"""
    return 0 if int(r) >= 10 else int(r)


# 11/15 係 C: 設定 context（差し替え）と kv_format（足す）．auto の値は VRAM で決める（sync_ctx.AUTO_TABLE）
import sync_ctx as _sync_ctx  # noqa: E402
_sync_ctx.install(sys.modules[__name__])


# ------------------------------------------------------------------ モデルの一覧
# 11/15 S2: 配布物の一覧（chat\models\models.dist.json）は local_dir が設定 models_dir からの相対．起動の道具がそれを
# 絶対の道のりにした写しを SYNC_HOME\models-state\catalog.json に書き，自分も中継（DSH_MODELS_CATALOG）もそれを読む．
# 本番の models.json（この PC の日常．絶対の道のり）は形を変えずにそのまま読む．
def _models_dir():
    v = _settings_file().get("models_dir")
    return os.path.abspath(v) if v and v != "auto" else OS.default_models_dir(home())


def resolve_catalog(dist_path, models_dir, out_path, python=None):
    """配布の一覧 → 絶対の道のりの一覧（中身が変わったときだけ書き直す）．書いた先を返す"""
    with open(dist_path, encoding="utf-8-sig") as f:
        c = json.load(f)
    for e in (c.get("models") or []) + (c.get("shared") or []):
        rel = e.get("local_dir", "")
        if os.path.isabs(rel) or re.match(r"^[A-Za-z]:", rel):
            raise ValueError(f"配布の一覧の local_dir は相対の道のりにする: {e.get('id')}")
        e["local_dir"] = os.path.normpath(os.path.join(models_dir, rel))
        e.pop("start_config", None)       # 配布物では起動の道具が起動の設定を作る（中継は SYNC_LAUNCHER 経由）
    c["models_dir"] = models_dir
    if python:
        c["python"] = python              # 中継がダウンロードの道具（model_dl.py）を流す Python＝同梱の物
    text = json.dumps(c, ensure_ascii=False, indent=1)
    try:
        with open(out_path, encoding="utf-8") as f:
            if f.read() == text:
                return out_path
    except OSError:
        pass
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out_path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return out_path


def configurable_catalog():
    dist = LAYOUT["catalog_dist"]
    return not (os.environ.get("SYNC_CATALOG") or LAYOUT["catalog"]) and bool(dist and os.path.isfile(dist))


def catalog_path():
    """読むモデルの一覧の道のり: 環境変数 SYNC_CATALOG → 本番の一覧（layout.dev.json の catalog）→ 配布の一覧を書き出した物"""
    if os.environ.get("SYNC_CATALOG"):
        return os.environ["SYNC_CATALOG"]
    if LAYOUT["catalog"]:
        return LAYOUT["catalog"]
    dist = LAYOUT["catalog_dist"]
    root = _models_dir()
    # A running relay and its workers retain their catalog when settings change.
    key = hashlib.sha256(os.fsencode(os.path.normcase(root))).hexdigest()
    out = os.path.join(home(), "models-state", "catalogs", key + ".json")
    if dist and os.path.isfile(dist):
        py = LAYOUT["python"] if LAYOUT["kind"] == "installed" and LAYOUT["python"] and os.path.isfile(LAYOUT["python"]) else None
        try:
            return resolve_catalog(dist, root, out, py)
        except (OSError, ValueError):
            pass
    return out


def catalog():
    try:
        with open(catalog_path(), encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"models": [], "shared": []}


def complete(entry):
    fs = entry.get("files") or []
    return bool(fs) and all(os.path.isfile(os.path.join(entry["local_dir"], f["path"])) and
                            os.path.getsize(os.path.join(entry["local_dir"], f["path"])) == f["bytes"] for f in fs)


def models_state():
    c = catalog()
    installed = [m["id"] for m in c.get("models", []) if complete(m)]
    missing_shared = [s["id"] for s in c.get("shared", []) if not s.get("optional") and not complete(s)]
    return {"installed": installed, "missing_shared": missing_shared, "catalog": catalog_path()}


def shared_paths():
    """共通の部品の置き場（エンジンの設定に入れる）．role → 道のり"""
    out = {}
    for s in catalog().get("shared", []):
        if not complete(s) or not s.get("files"):
            continue
        d = s["local_dir"]
        if len(s["files"]) == 1:
            p = os.path.normpath(os.path.join(d, s["files"][0]["path"]))
        else:   # 11/15 夜: 置き場の中の並び（<id>/<ファイル>）のまま落とした物は，ファイルの共通のフォルダー
            p = os.path.normpath(os.path.join(d, os.path.commonpath([os.path.dirname(f["path"]) or "." for f in s["files"]])))
        for r in s.get("role") or []:
            out[r] = p
    return out


# ------------------------------------------------------------------ 起こしたプロセスの記録
def _listen_ports():
    """待ち受けている TCP の番号の集まり（OS に聞く．つなぎに行かない）．11/15 S2: Windows では待ち受けの無い番号への
    つなぎが断られるまで 約 0.5〜1 秒かかり，status が毎回 2〜4 秒かかっていた．中身は oscompat.listen_ports"""
    return OS.listen_ports()


def listening(port, host="127.0.0.1"):
    ports = _listen_ports() if host in ("127.0.0.1", "localhost") else None
    if ports is not None:
        return int(port) in ports
    s = socket.socket()
    s.settimeout(0.5)
    try:
        return s.connect_ex((host, port)) == 0
    finally:
        s.close()


def _proc_created(pid):
    """プロセスの生まれた時刻（OS ごとの数）．無ければ None（oscompat）"""
    return OS.proc_created(pid)


def procs():
    try:
        return json.load(open(path("run", "procs.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_procs(d):
    p = path("run", "procs.json")
    json.dump(d, open(p + ".tmp", "w", encoding="utf-8"), indent=1)
    os.replace(p + ".tmp", p)


def remember(name, pid, port=None, **more):
    d = procs()
    d[name] = {"pid": pid, "created": _proc_created(pid), "port": port, "at": time.time(), **more}
    _save_procs(d)


def alive(name):
    r = procs().get(name)
    return bool(r) and r.get("created") is not None and _proc_created(r["pid"]) == r["created"]


def stop(name):
    """記録した番号のプロセスを止める（生まれた時刻も合うときだけ）．止めたら True"""
    d = procs()
    r = d.get(name)
    if not r:
        return False
    ok = False
    if r.get("created") is not None and _proc_created(r["pid"]) == r["created"]:
        ok = OS.terminate(r["pid"])
    d.pop(name, None)
    _save_procs(d)
    return ok


def _children(pid, created):
    """pid の子（親の番号が pid で，親より後に生まれた物）の番号．孫まで"""
    pairs = OS.proc_pairs()
    out, todo = [], [(pid, created)]
    while todo:
        ppid, pc = todo.pop()
        for c, par in pairs:
            if par == ppid and c != ppid:
                cc = _proc_created(c)
                if cc is not None and pc is not None and cc >= pc and (c, cc) not in out:
                    out.append((c, cc))
                    todo.append((c, cc))
    return out


def stop_tree(name):
    """記録した番号のプロセスと，その子・孫（生まれた時刻で確かめた物だけ）を止める（11/15 S2．stop-strata.ps1 の代わり）"""
    r = procs().get(name)
    if not r or r.get("created") is None or _proc_created(r["pid"]) != r["created"]:
        return stop(name)
    kids = _children(r["pid"], r["created"])
    ok = stop(name)
    for c, cc in kids:
        if _proc_created(c) == cc:
            OS.terminate(c)
    return ok


NO_WINDOW = 0x08000000 | 0x00000200   # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP（窓を出さず，起こした端末を閉じても残る）


def spawn(name, cmd, env=None, log=None, port=None, cwd=None):
    out = open(log, "a", encoding="utf-8") if log else subprocess.DEVNULL
    p = subprocess.Popen(cmd, env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, creationflags=NO_WINDOW,
                         close_fds=True)
    remember(name, p.pid, port)
    return p


def restrict(p):
    """このファイル（やフォルダー）を今の利用者だけが読めるようにする（oscompat）"""
    OS.restrict(p)


def wait_port(port, secs, proc=None):
    t0 = time.time()
    while time.time() - t0 < secs:
        if listening(port):
            return True
        if proc is not None and proc.poll() is not None:
            return False
        time.sleep(0.5)
    return listening(port)


def http_ok(url, timeout=3):
    try:
        return urllib.request.urlopen(url, timeout=timeout).status < 500
    except urllib.error.HTTPError as e:
        return e.code < 500
    except Exception:
        return False


# ------------------------------------------------------------------ dsh（会話の中継 → dsh web → 会話の画面の中継）
def task_exists():
    if not OS.IS_WIN:
        return False       # Linux にはこの PC の常駐のタスク（DshAutoStart）は無い
    r = subprocess.run(["schtasks", "/Query", "/TN", "DshAutoStart"], capture_output=True, creationflags=0x08000000)
    return r.returncode == 0


# ------------------------------------------------------------------ 11/16: ウェブ検索（RustXNG）
# 差し込み dsh-rustxng（MIT．配布物の dsh の部品の plugins/ に同梱）で，dsh の内蔵の web_search の裏側を RustXNG にする．
# RustXNG 本体（AGPL-3.0）は配布しない: 初めて検索したときに差し込みが本家の GitHub の固定の版から DSH_HOME/bin に落とし
# （本家の .sha256 で照らす），使わない間は止める（idleMinutes）．起動の道具は，dsh を起こす前に置いてある本体を下の固定の sha256 で
# 照らし，合わなければ消す（次の検索で落とし直す）．127.0.0.1:8888 に RustXNG がいればそれを使い，別の物がいれば別の番号で起こす．
RUSTXNG = {"version": "0.27.0", "port": 8888, "idle_minutes": 30,
           "sha256": {"windows": "93cb477f393740bfcd2dc3bc9268eebae748cef78253cdea0eb8a5414dcdc08b",
                      "linux": "bdfa4464fe6ee954cea5428d05b9ed79da2c745916e517f793bb2d3da7b184a0"}}
SEARCH_BEGIN = "# >>> sync-strata: web search (RustXNG). The launcher rewrites this block on every start; do not edit."
SEARCH_END = "# <<< sync-strata: web search"


def search_plugin():
    p = os.path.join(DSH_ROOT, "plugins", "dsh-rustxng", "index.js")
    return p if os.path.isfile(p) else None


def search_port():
    """RustXNG の番号: 8888 に RustXNG がいればそれ（例 この PC の本人の物），何もいなければ 8888（差し込みが起こす），
    別の物がいれば 8889〜8899 の空いている番号"""
    base = int(os.environ.get("SYNC_RUSTXNG_PORT") or RUSTXNG["port"])     # 試し用に替えられる
    try:
        if urllib.request.urlopen(f"http://127.0.0.1:{base}/healthz", timeout=2).status == 200:
            return base, "existing"
    except Exception:
        pass
    if not listening(base):
        return base, "free"
    for p in range(base + 1, base + 12):
        if not listening(p):
            return p, "other"
    return base, "busy"


def search_pin_check(dsh_home, say=print):
    """DSH_HOME/bin の RustXNG 本体を固定の sha256 で照らし，合わなければ消す（次の検索で落とし直す）"""
    import hashlib
    exe = os.path.join(dsh_home, "bin", "rustxng" + X)
    if not os.path.isfile(exe):
        return None
    h = hashlib.sha256()
    with open(exe, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    want = RUSTXNG["sha256"]["windows" if OS.IS_WIN else "linux"]
    if h.hexdigest() != want:
        try:
            os.remove(exe)
            say(f"  ウェブ検索の本体（{exe}）が固定の版と違うので消しました．次の検索で落とし直します")
        except OSError:
            pass
        return False
    return True


def _fit_search(text, s):
    """cordis.patch.yml にウェブ検索の塊（差し込みの読み込みと web の裏側）を入れる・合わせる．差し込みが無い並び，
    または元の設定にもう dsh-rustxng がある（作者の PC の日常の写し）ときは何もしない"""
    plugin = search_plugin()
    a, b = text.find(SEARCH_BEGIN), text.find(SEARCH_END)
    body = text if a < 0 else text[:a] + (text[b + len(SEARCH_END):] if b >= 0 else "")
    if not plugin or "dsh-rustxng" in body:
        return text
    port = s.get("_search_port") or RUSTXNG["port"]
    path_ = plugin.replace("\\", "/")
    block = "\n".join([
        SEARCH_BEGIN,
        "- insert:",
        "    - id: dsh-rustxng",
        f"      name: '{path_}'",
        "      config:",
        "        enabled: true",
        f"        baseUrl: 'http://127.0.0.1:{port}'",
        "        timeoutMs: 20000",
        "        defaultLimit: 10",
        "        exposeTools: false",
        "        webSearch: { enabled: true, autoSelect: false }",
        "        webFetch: { enabled: false, autoSelect: false }",
        f"        autoStart: {{ enabled: true, download: true, version: '{RUSTXNG['version']}', binaryPath: '', idleMinutes: {RUSTXNG['idle_minutes']} }}",
        "        debug: false",
        "- id: web",
        "  config:",
        "    searchProvider: rustxng",
        "    fetchProvider: http",
        SEARCH_END, ""])
    return body.rstrip("\n") + "\n\n" + block


def _fit_patch(text, s):
    """dsh の cordis.patch.yml を，この起動の会話の中継の番地と文脈の長さに合わせる（11/15 S2）．
    - 提供元 strata の baseURL の番号 → 設定 proxy_port
    - contextWindow → エンジンの文脈の長さ（設定 context．auto は 262144）．maxTokens はその半分（上限 65536，ひな形の値）
    ほかの行は変えない．"""
    ctx = int(s.get("context") or 262144)
    text = re.sub(r"http://127\.0\.0\.1:\d+/v1", f"http://127.0.0.1:{s['proxy_port']}/v1", text)
    text = re.sub(r"(?m)^(\s*contextWindow:\s*)\d+", lambda m: f"{m.group(1)}{ctx}", text)
    text = re.sub(r"(?m)^(\s*maxTokens:\s*)(\d+)", lambda m: f"{m.group(1)}{min(65536, max(1024, ctx // 2))}", text)
    text = _sync_ctx.fit_patch(text, ctx)   # 11/15 係 C: モデルの出力の上限を文脈の長さの表（sync_ctx.DSH_TABLE）で
    text = _fit_search(text, s)              # 11/16: ウェブ検索（RustXNG）
    return text


def prepare_dsh_home(s):
    """dsh_home に dsh の設定（profiles\\web）が無ければ，元の設定を写す．あれば cordis.patch.yml の中継の番地と文脈の長さだけ
    この起動に合わせる（setup が置いたひな形は 8081・262144 のまま．11/15 S2）．dsh が動いている間に変えたときは dsh の起こし直しで効く"""
    dst = os.path.join(s["dsh_home"], "profiles", "web")
    if search_plugin():          # 11/16: ウェブ検索の番号と本体の確かめ（差し込みがある並びだけ）
        s = dict(s, _search_port=search_port()[0])
        search_pin_check(s["dsh_home"])
    patch = os.path.join(dst, "cordis.patch.yml")
    if not os.path.exists(patch):
        os.makedirs(dst, exist_ok=True)
        for f in DSH_PROFILE_FILES:
            for name in (f, f + ".template"):
                src = os.path.join(DSH_PROFILE_SRC, name)
                if os.path.exists(src):
                    break
            else:
                continue
            text = open(src, encoding="utf-8").read()
            if f == "cordis.patch.yml":
                text = _fit_patch(text, s)
            with open(os.path.join(dst, f), "w", encoding="utf-8") as w:
                w.write(text)
        return dst
    text = open(patch, encoding="utf-8").read()
    fit = _fit_patch(text, s)
    if fit != text:
        with open(patch + ".tmp", "w", encoding="utf-8") as w:
            w.write(fit)
        os.replace(patch + ".tmp", patch)
    return dst


def dsh_up(s):
    return listening(s["dsh_port"]) and listening(s["relay_port"]) and listening(s["proxy_port"])


# ------------------------------------------------------------------ 11/18 W12: 既定の番号がほかのプログラムにふさがれている PC
# 4 つの番号（エンジン・会話の中継・dsh・会話の画面の中継）それぞれを，起こす前に調べる．自分の物でないプログラムが待ち受けている
# （または OS が使わせない）なら，空いている番号を選んで settings.json に書き，その番号で続ける．一度選んだ番号は次からも使う
# （スマホのブックマークが毎回変わらないように）．選んだ番号が自分の物・空きなら何もしない
PORT_KEYS = ("api_port", "proxy_port", "dsh_port", "relay_port")
PORT_NAME = {"api_port": "エンジン", "proxy_port": "会話の中継", "dsh_port": "dsh", "relay_port": "会話の画面の中継"}
PORT_PROC = {"proxy_port": "proxy", "dsh_port": "dsh", "relay_port": "relay"}
DEFAULT_PORTS = (8080, 8081, 3080, 3081)


def strata_health(port, timeout=2):
    """その番号の /health（鍵なしで答える）が Sync-Strata のエンジンの形か．serve は "service": "strata" を返す
    （古い版は service が無いので，max_context・images・api_key の 3 つの項目がそろえば同じ物と見る）．
    llama-server は {"status":"ok"}，Open WebUI は {"status":true} だけなので取り違えない"""
    try:
        r = urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout)
        if r.status != 200:
            return False
        d = json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return False
    return isinstance(d, dict) and (d.get("service") == "strata" or all(k in d for k in ("max_context", "images", "api_key")))


def engine_is_ours(port):
    """自分で起こしたエンジン（procs.json の engine の番号が合い，生きている）か，答えが Sync-Strata のエンジンの形のもの"""
    rec = procs().get("engine")
    if rec and alive("engine") and rec.get("port") == port:
        return True
    return strata_health(port)


def _bindable(port):
    """127.0.0.1 のその番号を今取れるか（OS が使わせない範囲・別のプログラムの占有は False）"""
    sk = socket.socket()
    try:
        if not OS.IS_WIN:
            sk.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sk.bind(("127.0.0.1", int(port)))
        return True
    except OSError:
        return False
    finally:
        sk.close()


def port_blocked(key, port):
    """その番号をほかのプログラムが使っているか（自分の物でない待ち受け，または待ち受けは無いが取れない番号）"""
    if listening(port):
        ours = engine_is_ours(port) if key == "api_port" else alive(PORT_PROC[key])
        return not ours
    if key != "api_port" and alive(PORT_PROC[key]):
        return False
    return not _bindable(port)


def pick_port(base, avoid):
    """base の近く（base+1 から順に．既定の 4 つの番号と avoid は避ける）で空いている番号．無ければ OS に聞く"""
    used = _listen_ports() or set()
    for p in range(base + 1, min(base + 300, 65535)):
        if p in avoid or p in used or p in DEFAULT_PORTS:
            continue
        if _bindable(p):
            return p
    sk = socket.socket()
    try:
        sk.bind(("127.0.0.1", 0))
        return sk.getsockname()[1]
    finally:
        sk.close()


def ensure_ports(s, say=print, persist=True):
    """s（effective() の値）の 4 つの番号を調べ，ふさがっている番号は空いている番号に替える（s を直接書き換える）．
    替えた番号は persist なら settings.json に書く（--dry は書かない）．替えた {設定名: 新しい番号} を返す．
    SYNC_USE_DSH_TASK=1（作者の PC の常駐の dsh に任せる）のときは，dsh・中継の 3 つは見ない"""
    keys = ("api_port",) if os.environ.get("SYNC_USE_DSH_TASK") == "1" else PORT_KEYS
    taken = {int(s[k]) for k in PORT_KEYS}
    changed = {}
    for k in keys:
        p = int(s[k])
        dup = [o for o in PORT_KEYS if o != k and int(s[o]) == p and PORT_KEYS.index(o) < PORT_KEYS.index(k)]   # 設定で 2 つが同じ番号
        if not dup and not port_blocked(k, p):
            continue
        n = pick_port(p, taken)
        taken.add(n)
        s[k] = n
        changed[k] = n
        say(f"  番号 {p}（{PORT_NAME[k]}）はほかのプログラムが使っているので，{n} にしました．" if not dup
            else f"  番号 {p}（{PORT_NAME[k]}）がほかの部品と重なっているので，{n} にしました．")
    if persist:
        for k, n in changed.items():
            try:
                settings_set(k, str(n))
            except (OSError, ValueError, KeyError):
                pass
    return changed


DSH_ERROR = None      # 11/16: start_dsh が起こせなかった理由（up の JSON の error に出す）
PORT_LABEL = {"proxy": ("会話の中継", "proxy_port"), "dsh": ("dsh", "dsh_port"), "relay": ("会話の画面の中継", "relay_port")}


def start_dsh(s, say=print):
    """3 つを順に起こす（自分で起こして動いている物はそのまま）．
    11/16 本人の実機チェック: 既定では必ず自分の dsh を起こす．作者の PC の常駐（タスク DshAutoStart）に任せるのは，明示の旗
    SYNC_USE_DSH_TASK=1 のときだけ（前は既定の番号ならタスクに任せて 150 秒待ち，タスクを止めていると起きずに失敗した）．
    番号を自分で起こしていない別のプログラムが使っていれば，黙ってつながずに理由を出して止まる"""
    global DSH_ERROR
    DSH_ERROR = None
    ensure_ports(s, say)      # 11/18 W12: ふさがっている番号は空いている番号に替えて続ける（s を書き換える）
    ports = {"proxy": s["proxy_port"], "dsh": s["dsh_port"], "relay": s["relay_port"]}
    use_task = os.environ.get("SYNC_USE_DSH_TASK") == "1"
    if not use_task:
        foreign = [(n, p) for n, p in ports.items() if listening(p) and not alive(n)]
        if foreign:
            DSH_ERROR = "；".join(f"番号 {p}（{PORT_LABEL[n][0]}）を別のプログラムが使っています" for n, p in foreign) + \
                "．そのプログラムを止めるか，sync settings set " + "・".join(PORT_LABEL[n][1] for n, _ in foreign) + " <別の番号> で替えてください"
            say("  " + DSH_ERROR)
            return False
        if all(listening(p) for p in ports.values()):
            return True
    elif dsh_up(s):
        return True
    if use_task and task_exists():
        subprocess.run(["schtasks", "/Run", "/TN", "DshAutoStart"], capture_output=True, creationflags=0x08000000)
        t0 = time.time()
        while time.time() - t0 < 150 and not dsh_up(s):
            time.sleep(2)
        return dsh_up(s)
    node = node_exe()
    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    logs = os.path.dirname(path("logs", "x"))
    if not listening(s["proxy_port"]):
        prune_sessions(s, say)                    # 11/16: 起こす前に古い控えを消す
        sd, cap, low = sessions_plan(s)
        e = dict(env, PROXY_PORT=str(s["proxy_port"]), STRATA_URL=f"http://127.0.0.1:{s['api_port']}",
                 SESSION_DIR=sd, PROXY_LOG=os.path.join(logs, "session-proxy.log"), MAX_GIB=f"{cap:.2f}",
                 HEAD_MODEL_NAME_FILE=path("run", "head-model-name.txt"),   # 11/18 W11: 起動の道具が sync up のたびに書く（中継が頼みごとに読む．モデルを替えても名前が追いつく）
                 WARM_HEAD_FILE=path("run", "warm-head.json"),    # 11/18 W11: dsh の頭の記録（起動の道具の温めが読む．会話の中身は入らない）
                 **({"MIN_SAVE_TOKENS": "1000000000"} if low else {}))   # 11/16: エンジンの slot_save_path と同じ置き場・上限・空きが少なければ書かない
        if low:
            say(f"  {sd} のドライブの空きが {LOW_FREE_GIB:.0f} GiB 未満なので，会話の控えは書きません")
        p = spawn("proxy", [node, PROXY_JS], env=e, log=os.path.join(logs, "session-proxy.out"), port=s["proxy_port"])
        if not wait_port(s["proxy_port"], 30, p):
            say(f"  会話の中継（{s['proxy_port']}）が起きませんでした（{os.path.join(logs, 'session-proxy.out')}）")
            return False
    if not listening(s["dsh_port"]):
        prepare_dsh_home(s)
        run = os.path.dirname(path("run", "x"))
        restrict(run)
        url_file = os.path.join(run, "dsh-url.json")
        if os.path.exists(url_file):
            os.remove(url_file)
        ws = os.path.dirname(path("workspace", "x"))
        e = dict(env, DSH_HOME=s["dsh_home"], STRATA_API_KEY=env.get("STRATA_API_KEY") or "strata-local")
        # dsh は窓の無い見張り（dsh_host.py）の子として起こす: ログイン用の URL（トークン入り）だけを抜き出して url_file に置き，記録には伏せて書く
        cmd = [sys.executable, "-X", "utf8", os.path.join(HERE, "dsh_host.py"), "--url-file", url_file, "--log", os.path.join(logs, "dsh.log"),
               "--", node, DSH_BIN, "web", "--no-open", "--port", str(s["dsh_port"])]
        cmd = _sync_ctx.dsh_cmd(cmd, s, node, DSH_BIN, e, say)   # 11/15 係 C: 要約の始まりを文脈の長さに（--patch の上書き）
        import sync_remote; cmd += sync_remote.dsh_args(s)   # 11/15 係 R: スマホの接続の名前を dsh の --trusted-host に
        p = spawn("dsh", cmd, env=e, port=s["dsh_port"], cwd=ws)
        if not wait_port(s["dsh_port"], 120, p):
            say(f"  dsh（{s['dsh_port']}）が起きませんでした（{os.path.join(logs, 'dsh.log')}）")
            return False
    if alive("dsh"):
        ensure_workspace(s, say)      # 11/15 夜: 初回は作業フォルダーが無く送れなかった（本物の通しで見つかった）
    if not listening(s["relay_port"]):
        e = dict(env, DSH_MOBILE_PORT=str(s["relay_port"]), DSH_PORT=str(s["dsh_port"]), STRATA_URL=f"http://127.0.0.1:{s['api_port']}",
                 SYNC_LAUNCHER=os.path.join(HERE, "sync.py"), SYNC_PYTHON=sys.executable, SYNC_HOME=home(),
                 DSH_MOBILE_STATE_DIR=os.path.dirname(path("relay", "x")), DSH_MODELS_STATE=os.path.dirname(path("models-state", "x")),
                 DSH_MODELS_CATALOG=catalog_path())
        import sync_remote; sync_remote.relay_env(s, e)   # 11/15 係 R: スマホの接続（lan_remote）の番地を中継に
        p = spawn("relay", [node, RELAY_JS], env=e, log=os.path.join(logs, "relay.out"), port=s["relay_port"])
        if not wait_port(s["relay_port"], 30, p):
            say(f"  会話の画面の中継（{s['relay_port']}）が起きませんでした（{os.path.join(logs, 'relay.out')}）")
            return False
    return True


# ------------------------------------------------------------------ 11/15 夜: 初回の作業フォルダー
def dsh_login(s, wait=20):
    """自分で起こした dsh にログインした urllib の opener と番地（ログイン用の URL は run\\dsh-url.json．トークンは表示しない）"""
    import http.cookiejar
    url_file = os.path.join(home(), "run", "dsh-url.json")
    t0 = time.time()
    u = ""
    while time.time() - t0 < wait:
        try:
            u = json.load(open(url_file, encoding="utf-8")).get("url", "")
        except (OSError, ValueError):
            u = ""
        if u:
            break
        time.sleep(0.5)
    if not u:
        return None, None
    base = f"http://127.0.0.1:{s['dsh_port']}"
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(re.sub(r"^https?://[^/]+", base, u), timeout=15).read()
    return op, base


def dsh_call(op, base, endpoint, args):
    """dsh の API を 1 回（画面の api.js の call と同じ形）．result.value を返す．断られたら RuntimeError(code: message)"""
    import uuid
    body = json.dumps({"type": "client-request", "rpcId": str(uuid.uuid4()), "method": endpoint, "payload": {"args": args}}).encode()
    req = urllib.request.Request(f"{base}/api/{endpoint}", data=body, method="POST",
                                 headers={"content-type": "application/json", "Origin": base, "Sec-Fetch-Site": "same-origin"})
    env = json.loads(op.open(req, timeout=30).read())
    r = (env or {}).get("result") or {}
    if not r.get("ok"):
        e = r.get("error") or {}
        raise RuntimeError(f"{e.get('code', 'unknown')}: {e.get('message', '')}")
    return r.get("value")


def ensure_workspace(s, say=print):
    """初回にそのまま話せるように，既定の作業フォルダー SYNC_HOME\\workspace を自分で起こした dsh に登録する（無ければ作る）．
    登録したら dsh_home の .sync-workspace.json に残し，次からは何もしない．会話の画面は作業フォルダーが 1 つならそれを選ぶ"""
    ws = os.path.join(home(), "workspace")
    os.makedirs(ws, exist_ok=True)
    mark = os.path.join(s["dsh_home"], ".sync-workspace.json")
    try:
        m = json.load(open(mark, encoding="utf-8"))
        if os.path.normcase(m.get("path", "")) == os.path.normcase(ws) and m.get("workspaceId"):
            return True
    except (OSError, ValueError):
        pass
    try:
        op, base = dsh_login(s)
        if not op:
            say("  作業フォルダーを登録できませんでした（dsh のログイン用の URL がまだ無い）")
            return False
        try:
            v = dsh_call(op, base, "workspace/create", {"request": {"path": ws}})
        except RuntimeError as e:
            if not re.search(r"exist|already|duplicate", str(e), re.I):
                raise
            v = None
        # 返り値は {workspace: {workspaceId, …}, created}（もう登録済みなら created: false で同じ物が返る）
        wid = ((v or {}).get("workspace") or {}).get("workspaceId") if isinstance(v, dict) else None
        json.dump({"path": ws, "workspaceId": wid, "at": time.time()}, open(mark, "w", encoding="utf-8"))
        return True
    except Exception as e:
        say(f"  作業フォルダーを登録できませんでした（{str(e)[:120]}）．会話の画面の「フォルダーを足す」で足せます")
        return False


def stop_dsh(s, say=print):
    """自分で起こした中継・dsh・会話の中継だけを止める．常駐の物は止めない"""
    did = []
    for name in ("relay", "dsh", "proxy"):
        if name == "dsh" and alive("dsh"):
            # 見張りを止める前に，その子の dsh（node）を止める（見張りが記録した番号．生まれた時刻も確かめる）
            child = procs().get("dsh-node")
            if child:
                stop("dsh-node")
        if stop(name):
            did.append(name)
    for name, port in (("relay", s["relay_port"]), ("dsh", s["dsh_port"]), ("proxy", s["proxy_port"])):
        if name not in did and listening(port):
            say(f"  {port} は自分で起こした物ではないので止めません（この PC の常駐の dsh など）")
    if "proxy" in did:
        try:
            prune_sessions(s, say)                # 11/16: 止めた後に古い控えを消す
        except Exception:
            pass
    url = os.path.join(home(), "run", "dsh-url.json")
    if "dsh" in did and os.path.exists(url):
        os.remove(url)
    return did


def gui_url(s):
    """窓の最初の行き先．自分で起こした dsh ならログイン用の URL を中継の login.html に渡す形（トークンは # の後ろ＝中継の記録に残らない）"""
    base = f"http://127.0.0.1:{s['relay_port']}"
    try:
        u = json.load(open(os.path.join(home(), "run", "dsh-url.json"), encoding="utf-8")).get("url", "")
    except (OSError, ValueError):
        u = ""
    m = re.search(r"[?&]token=([^&#\s]+)", u)
    if m and alive("dsh"):
        return f"{base}/m/login.html#token={m.group(1)}"
    return f"{base}/m/"
