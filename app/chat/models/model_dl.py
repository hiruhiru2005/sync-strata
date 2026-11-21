#!/usr/bin/env python3
"""モデル（pack）のダウンロードと検査（11/15．会話の画面の Strata の欄から中継 server.mjs が起こす別プロセス）．

  py -3 -X utf8 model_dl.py --catalog models.json --id sync-s --status <状態.json> [--stop-file <止める印>]
                            [--local-dir <置き場を替える>] [--only MANIFEST.json ...] [--verify-only] [--endpoint URL]

流れ:
  1. 一覧（models.json）の 1 件を読む．置き場の空きが「残りの大きさ＋2 GiB」より少なければ断る．
  2. MANIFEST.json を先に落とす（小さい）．各ファイルの大きさと sha256 はここから読む．
  3. 小さいファイルから順に huggingface_hub.hf_hub_download(local_dir=置き場) で落とす．途中で止めても，
     置き場の .cache/huggingface/download/ に残る途中のファイル（.incomplete）から続きを落とす（同じ呼び出しで再開）．
  4. 全部そろったら MANIFEST.json の sha256 で全ファイルを確かめる．合わないファイルは消す（次の再開で落とし直す）．
  5. 確かめた結果を <状態の置き場>/verified-<id>.json に残す（中継が「検査済み」を出すのに使う）．
進み具合は --status の JSON に 0.5 秒ごとに書く（state: starting / downloading / verifying / done / failed / stopped）．
止めるのは --stop-file の印（中継が作る）．印を見たら，落としている途中でも区切りのよい所で終わる（state: stopped）．
鍵（Hugging Face のトークン）は huggingface_hub が自分で読む．この道具は読まない・書かない・表示しない．
xet（HF の新しい配り方）は既定で使わない（一覧の use_xet）: 普通の HTTP のほうが途中のファイルからの再開が確かなため．
"""
import argparse, hashlib, json, os, shutil, sys, threading, time


# 11/15 係 C: Hugging Face のトークンの置き場はアプリ専用（中継が --hf-home SYNC_HOME\hf を渡す）．PC 全体のログインの置き場
# （~/.cache/huggingface・環境変数 HF_TOKEN）は使わない・読まない．トークンは表示・記録しない．
#   model_dl.py token status|set|clear --hf-home DIR [--endpoint URL]   （set はトークンを標準入力から 1 行で受ける）
def _app_hf_env(hf_home):
    os.makedirs(hf_home, exist_ok=True)
    os.environ["HF_HOME"] = hf_home
    for k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_TOKEN_PATH", "HF_STORED_TOKENS_PATH"):
        os.environ.pop(k, None)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def _token_main(argv):
    import io, logging
    act = argv[0] if argv else ""
    get = lambda k: argv[argv.index(k) + 1] if k in argv and argv.index(k) + 1 < len(argv) else ""
    home = get("--hf-home")
    say = lambda d: print(json.dumps(d, ensure_ascii=False), flush=True)
    if act not in ("status", "set", "clear") or not home:
        say({"ok": False, "error": "使い方: token status|set|clear --hf-home DIR"})
        return 2
    _app_hf_env(home)
    if get("--endpoint"):
        os.environ["HF_ENDPOINT"] = get("--endpoint")
    tok_file = os.path.join(home, "token")
    if act == "status":
        say({"ok": True, "set": os.path.isfile(tok_file) and os.path.getsize(tok_file) > 0})
        return 0
    if act == "clear":
        for f in (tok_file, os.path.join(home, "stored_tokens")):
            try:
                os.remove(f)
            except FileNotFoundError:
                pass
        say({"ok": True, "set": False})
        return 0
    tok = sys.stdin.readline().strip()
    if not tok:
        say({"ok": False, "error": "トークンが空です"})
        return 2
    real_out, real_err = sys.stdout, sys.stderr
    logging.disable(logging.CRITICAL)
    sys.stdout = sys.stderr = io.StringIO()       # huggingface_hub の案内（トークンの名前など）は出さない
    err = None
    try:
        import huggingface_hub as hfh
        hfh.login(token=tok, add_to_git_credential=False)
    except Exception as e:     # noqa: BLE001  中身（トークンを含みうる）は出さず，種類だけで 1 行にする
        name = type(e).__name__
        code = getattr(getattr(e, "response", None), "status_code", None)
        if code in (401, 403) or name in ("HfHubHTTPError", "HTTPError") and code is None:
            err = "トークンが正しくありません（Hugging Face で読み取り用のトークンを作り直してください）"
        elif isinstance(e, ValueError):
            err = "個人のアカウントのトークンを使ってください"
        elif name in ("ConnectError", "ConnectTimeout", "ReadTimeout", "ConnectionError", "OfflineModeIsEnabled"):
            err = "Hugging Face につながりませんでした（ネットワークを確かめてください）"
        else:
            err = f"トークンを保存できませんでした（{name}）"
    finally:
        sys.stdout, sys.stderr = real_out, real_err
        logging.disable(logging.NOTSET)
    del tok
    if err:
        say({"ok": False, "set": os.path.isfile(tok_file), "error": err})
        return 1
    say({"ok": True, "set": os.path.isfile(tok_file) and os.path.getsize(tok_file) > 0})
    return 0


def _flush_status(status):
    """終わる前に，置き換えに失敗した状態（.tmp が残る）を置き直す．中継が読んでいる最中だと write() の置き換えが 5 回とも
    失敗し，中継が「途中で終わりました」と書いて error_kind も失われていた（11/15 の試しで実際に起きた．成功のときも同じ）"""
    for _ in range(60):
        if not os.path.exists(status + ".tmp"):
            return
        try:
            os.replace(status + ".tmp", status)
        except PermissionError:
            time.sleep(0.05)


if len(sys.argv) > 1 and sys.argv[1] == "token":
    sys.exit(_token_main(sys.argv[2:]))


ap = argparse.ArgumentParser()
ap.add_argument("--catalog", required=True)
ap.add_argument("--id", required=True)
ap.add_argument("--status", required=True)
ap.add_argument("--stop-file", default="")
ap.add_argument("--local-dir", default="", help="置き場を一覧と違う所にする（確かめ用）")
ap.add_argument("--only", nargs="*", default=None, help="このファイルだけ落とす（確かめ用．検査もこの分だけ）")
ap.add_argument("--verify-only", action="store_true", help="落とさずに，手元のファイルを MANIFEST.json で確かめるだけ")
ap.add_argument("--endpoint", default="", help="Hugging Face の番地を替える（手元の偽の配信で確かめるとき）")
ap.add_argument("--verified-dir", default="", help="verified-<id>.json の置き場（既定は --status と同じフォルダー）")
ap.add_argument("--hf-home", default="", help="Hugging Face のトークンの置き場（アプリ専用．11/15 係 C）")
A = ap.parse_args()
if A.hf_home:   # 11/15 係 C: アプリ専用の置き場のトークンだけを使う
    _app_hf_env(A.hf_home)
import atexit  # noqa: E402
atexit.register(_flush_status, A.status)   # 11/15 係 C: 終わる前に状態を確かに置く（_flush_status の説明）

CAT = json.load(open(A.catalog, encoding="utf-8"))
# 11/15 app1115: 共通の部品（一覧の shared）も同じ道で落とす
M = next((m for m in CAT.get("models", []) + CAT.get("shared", []) if m["id"] == A.id), None)
if not CAT.get("use_xet"):
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
LOCAL = A.local_dir or (M or {}).get("local_dir", "")
VERIFIED_DIR = A.verified_dir or os.path.dirname(os.path.abspath(A.status))
GIB = 1024 ** 3

S = {"id": A.id, "local_dir": os.path.abspath(LOCAL), "pid": os.getpid(), "state": "starting", "started_at": time.time(), "file": None, "files_done": 0,
     "files_total": 0, "done_bytes": 0, "total_bytes": 0, "speed_bps": None, "eta_s": None, "error": None, "message": None,
     "verify": None, "mode": "verify" if A.verify_only else "download"}
LOCK = threading.Lock()
_last_write = [0.0]


def write(force=False):
    now = time.time()
    if not force and now - _last_write[0] < 0.5:
        return
    _last_write[0] = now
    S["updated_at"] = now
    tmp = A.status + ".tmp"
    with LOCK:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(S, f, ensure_ascii=False)
        for _ in range(5):
            try:
                os.replace(tmp, A.status)
                break
            except PermissionError:      # 中継が読んでいる最中（Windows）．少し待って置き直す
                time.sleep(0.05)


class Stopped(Exception):
    pass


def stop_asked():
    return bool(A.stop_file) and os.path.exists(A.stop_file)


# 速さと残り時間: 直近 8 秒の落とした量から（再開のときに既にあった分は数えない）
_samples = []


def account(done):
    now = time.time()
    _samples.append((now, done))
    while len(_samples) > 2 and now - _samples[0][0] > 8:
        _samples.pop(0)
    if len(_samples) >= 2 and _samples[-1][0] - _samples[0][0] >= 1.0:
        sp = (_samples[-1][1] - _samples[0][1]) / (_samples[-1][0] - _samples[0][0])
        S["speed_bps"] = round(sp)
        left = S["total_bytes"] - done
        S["eta_s"] = round(left / sp) if sp > 0 else None


CUR = {"base": 0, "file_n": 0}   # base: 済んだファイルの合計．file_n: いまのファイルの落とした量（再開の分を含む）


class Progress:
    """huggingface_hub の進み具合の棒の代わり（tqdm ではない．hf は cls(**kwargs) で作り，update(n) を呼ぶ）．
    再開のときは initial に途中の大きさが来る．止める印もここで見る（落としている途中に止められるように）"""

    def __init__(self, *a, total=None, initial=0, **k):
        CUR["file_n"] = initial or 0
        self.n = initial or 0
        self.total = total

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def update(self, n=1):
        self.n += n
        CUR["file_n"] = self.n
        done = CUR["base"] + CUR["file_n"]
        S["done_bytes"] = done
        account(done)
        write()
        if stop_asked():
            raise Stopped()

    def close(self):
        pass

    def set_description(self, *a, **k):
        pass

    def refresh(self, *a, **k):
        pass


def sha256_of(path, on_bytes):
    h = hashlib.sha256()
    with open(path, "rb", buffering=0) as f:
        while True:
            b = f.read(8 << 20)
            if not b:
                break
            h.update(b)
            on_bytes(len(b))
            if stop_asked():
                raise Stopped()
    return h.hexdigest()


def fail(msg, code=1):
    S["state"] = "failed"
    S["error"] = msg
    write(True)
    sys.exit(code)


def explain(e):
    """huggingface_hub の誤りを，画面に出す 1 行に（鍵の中身は出さない）"""
    name = type(e).__name__
    text = str(e).splitlines()[0][:200] if str(e) else name
    auth = name in ("RepositoryNotFoundError", "GatedRepoError") or " 401 " in f" {text} " or "401 Client Error" in text         or " 403 " in f" {text} " or "403 Client Error" in text   # 11/17 W1: 403 も（トークンが足りない・権限が無い）
    if A.hf_home and auth:   # 11/15 係 C
        S["error_kind"] = "auth"   # 11/17 W1: 画面にトークンの欄は無い．端末で入れる（model_dl.py token set --hf-home <SYNC_HOME>/hf）．画面は自分の言葉で言う
        return "非公開の置き場です。トークンを端末で入れてください。"
    if auth:
        return "Hugging Face の置き場を開けませんでした（非公開の置き場です。この PC で hf auth login をしてから再開してください）"
    if name == "RevisionNotFoundError":
        return "置き場に一覧の版（revision）がありません．一覧（models.json）を新しくしてください"
    if name == "EntryNotFoundError":
        return f"置き場にファイルがありません: {text}"
    # 11/15: huggingface_hub 1.12 はつながらないとき，やり直しの中で「client has been closed」の RuntimeError を出す
    if name in ("ConnectError", "ConnectTimeout", "ReadTimeout", "LocalEntryNotFoundError", "OfflineModeIsEnabled")             or "client has been closed" in text:
        return "Hugging Face につながりませんでした（ネットワークを確かめて再開してください）"
    return f"{name}: {text}"


KEPT = []   # 検査で合わなかったが，前から手元にあったので消さなかったファイル


def verify(files, manifest, deletable=()):
    """MANIFEST.json の sha256 で確かめる．合わないファイルの名前を返す．消すのは deletable（今回ダウンロードした物）だけで，
    前から手元にあったファイルは消さない（11/15: 本人が作った pack の専門家のファイルを，検査のボタンで消さないため）"""
    total = sum(manifest[f]["bytes"] for f in files)
    S.update(state="verifying", verify={"done_bytes": 0, "total_bytes": total, "bad": [], "file": None})
    write(True)
    vdone = [0]

    def on(n):
        vdone[0] += n
        S["verify"]["done_bytes"] = vdone[0]
        write()
    bad, rec = [], {}
    for f in files:
        S["verify"]["file"] = f
        p = os.path.join(LOCAL, f)
        want = manifest[f]
        if not os.path.exists(p) or os.path.getsize(p) != want["bytes"]:
            bad.append(f)
            continue
        if not want.get("sha256"):          # 11/15 app1115: 指紋の無いファイル（共通の部品の一部）は大きさだけ
            st = os.stat(p)
            rec[f] = {"bytes": st.st_size, "mtime_ns": str(st.st_mtime_ns)}
            continue
        got = sha256_of(p, on)
        if got != want["sha256"]:
            bad.append(f)
            if f not in deletable:
                KEPT.append(f)
                continue
            try:
                os.remove(p)
            except OSError:
                pass
            meta = os.path.join(LOCAL, ".cache", "huggingface", "download", f + ".metadata")
            if os.path.exists(meta):          # 印を残すと huggingface_hub が「もうある」と見て落とし直さない
                os.remove(meta)
        else:
            st = os.stat(p)
            rec[f] = {"bytes": st.st_size, "mtime_ns": str(st.st_mtime_ns)}
    S["verify"]["bad"] = bad
    return bad, rec


def main():
    if M is None:
        fail(f"一覧に {A.id} がありません")
    if not LOCAL:
        fail("置き場（local_dir）が一覧にありません")
    S["message"] = None
    write(True)
    os.makedirs(LOCAL, exist_ok=True)
    files = [f["path"] for f in M["files"]]
    if A.only:
        files = [f for f in files if f in A.only] or list(A.only)
    sizes = {f["path"]: f["bytes"] for f in M["files"]}
    # 始める前から大きさどおりにあったファイル（今回のダウンロードでは触らない物）
    pre = {f for f in files if os.path.exists(os.path.join(LOCAL, f)) and os.path.getsize(os.path.join(LOCAL, f)) == sizes.get(f, -1)}

    if not A.verify_only:
        try:
            import huggingface_hub as hfh
        except ImportError:
            fail("huggingface_hub が入っていません（py -3 -m pip install huggingface_hub）")
        hf = M.get("hf") or {}
        if not hf.get("repo"):
            fail(f"{M.get('name', A.id)} の置き場（Hugging Face）がまだ決まっていません（一覧 models.json の hf.repo）")
        kw = dict(repo_id=hf["repo"], revision=hf.get("revision") or None, repo_type=hf.get("repo_type") or "model",
                  local_dir=LOCAL, tqdm_class=Progress)
        if A.endpoint:
            kw["endpoint"] = A.endpoint
        # 空きの確かめ（残りの大きさ＋2 GiB）
        have = 0
        for f in files:
            p = os.path.join(LOCAL, f)
            if os.path.exists(p) and os.path.getsize(p) == sizes.get(f, -1):
                have += sizes[f]
        total = sum(sizes.get(f, 0) for f in files)
        free = shutil.disk_usage(LOCAL).free
        if free < total - have + 2 * GIB:
            fail(f"置き場のドライブの空きが足りません（要 {(total - have) / GIB + 2:.1f} GiB、空き {free / GIB:.1f} GiB）", 3)
        # 小さいファイルから（MANIFEST.json が一番先．大きいファイルは最後）
        order = sorted(files, key=lambda f: (f != "MANIFEST.json", sizes.get(f, 0)))
        S.update(state="downloading", total_bytes=total, files_total=len(order), done_bytes=0)
        write(True)
        for i, f in enumerate(order):
            if stop_asked():
                raise Stopped()
            S["file"] = f
            CUR["file_n"] = 0
            write(True)
            try:
                hfh.hf_hub_download(filename=f, **kw)
            except Stopped:
                raise
            except Exception as e:     # noqa: BLE001  画面に 1 行で出す（詳しくは標準出力＝中継の記録へ）
                import traceback
                traceback.print_exc()
                fail(explain(e))
            CUR["base"] += sizes.get(f, os.path.getsize(os.path.join(LOCAL, f)))
            CUR["file_n"] = 0
            S.update(files_done=i + 1, done_bytes=CUR["base"])
            account(CUR["base"])
            write(True)

    mpath = os.path.join(LOCAL, "MANIFEST.json")
    if not any(f["path"] == "MANIFEST.json" for f in M["files"]):
        # 11/15 app1115: MANIFEST.json の無い物（共通の部品）は，一覧の大きさと sha256 で確かめる
        manifest = {f["path"]: {"bytes": f["bytes"], "sha256": f.get("sha256")} for f in M["files"]}
        bad, rec = verify(files, manifest, deletable=set() if A.verify_only else {f for f in files if f not in pre})
        out = {"id": A.id, "local_dir": os.path.abspath(LOCAL), "at": time.time(), "ok": not bad and not A.only,
               "partial": bool(A.only), "bad": bad, "files": rec}
        os.makedirs(VERIFIED_DIR, exist_ok=True)
        json.dump(out, open(os.path.join(VERIFIED_DIR, f"verified-{A.id}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        if bad:
            fail("検査で合わないファイルがありました: " + ", ".join(bad), 4)
        S.update(state="done", file=None, eta_s=0, message="検査済み")
        write(True)
        return
    if not os.path.exists(mpath):
        fail("MANIFEST.json がありません（検査できません）")
    manifest = json.load(open(mpath, encoding="utf-8")).get("files") or {}
    check = [f for f in files if f != "MANIFEST.json"]
    missing = [f for f in check if f not in manifest]
    if missing:
        fail(f"MANIFEST.json に載っていないファイルがあります: {', '.join(missing)}")
    wrong = [f for f in check if f in sizes and sizes[f] != manifest[f]["bytes"]]
    if wrong:
        fail(f"一覧と MANIFEST.json で大きさが違います: {', '.join(wrong)}（一覧を新しくしてください）")
    bad, rec = verify(check, manifest, deletable=set() if A.verify_only else {f for f in check if f not in pre})
    st = os.stat(mpath)
    rec["MANIFEST.json"] = {"bytes": st.st_size, "mtime_ns": str(st.st_mtime_ns)}
    out = {"id": A.id, "local_dir": os.path.abspath(LOCAL), "at": time.time(), "ok": not bad and not A.only,
           "partial": bool(A.only), "bad": bad, "files": rec}
    os.makedirs(VERIFIED_DIR, exist_ok=True)
    json.dump(out, open(os.path.join(VERIFIED_DIR, f"verified-{A.id}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if bad:
        gone = [f for f in bad if f not in KEPT]
        msg = "検査で合わないファイルがありました: " + ", ".join(bad)
        if gone:
            msg += "（今回落とした " + ", ".join(gone) + " は消しました．再開で落とし直します）"
        if KEPT:
            msg += "（前から手元にあった " + ", ".join(KEPT) + " は消していません）"
        fail(msg, 4)
    S.update(state="done", file=None, eta_s=0, message="検査済み" if not A.only else "指定のファイルだけ落として検査しました")
    write(True)


if __name__ == "__main__":
    try:
        main()
    except Stopped:
        S.update(state="stopped", speed_bps=None, eta_s=None)
        write(True)
        sys.exit(0)
    except KeyboardInterrupt:
        S.update(state="stopped")
        write(True)
        sys.exit(0)
