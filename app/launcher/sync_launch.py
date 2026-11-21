#!/usr/bin/env python3
"""ダブルクリック 1 回の起動の試作（11/15 夜．本人の計画 ⑧A）．この PC の日常の起動（作業場の *.ps1）と設定は変えない．

  py -3 -X utf8 sync_launch.py [--preset speed|quality] [--pack auto|sync-m|sync-s] [--dry] [--no-gui] [--engine EXE] [--env K=V ...]
                               [--stop]

流れ（利用者が選ぶのは preset だけ．ほかは自動）:
  1. もう動いていれば，画面を開くだけ．
  2. PC を調べる（tools/night/wintune.py preflight）: RAM の空き，VRAM の空き，画面をつないでいるか，裏で SSD を読むもの，RAM を食うアプリ．
  3. pack を選ぶ: 品質重視＝「SSD に残る専門家が 3% 以下」で入るいちばん大きい pack．速度重視＝ 1 段小さい pack でも全部 RAM に載るほう．
     手元に無い pack は選ばない（公開版ではここでダウンロード．download_plan() に手順だけ書いてある）．
     11/15 S2: pack の一覧はモデルの一覧（models.json か配布の一覧）から作る．pending（pack がまだ無い）は選ばない．
     Sync-XS が選ばれるのは大きい pack が全部は載らないとき（RAM 不足・VRAM 不足）だけ．速度重視でも Sync-XS へは下げない（11/15 16:55 本人）．
  4. 設定を作る: RAM の枠（空き − エンジン 2.7 − 余白 1.0 GiB，上限は pack − VRAM の席），VRAM の予約（画面あり 1,024・なし 512 MiB），
     tail skip（速度 R4・品質 R7），輪なし，固定は枠＋1．分担（--pcie-frac）と RAM の写しの育て方は，エンジンの自動の旗（--env で渡す）に任せる．
  5. dsh を起こし（動いていれば何もしない），Strata を起こし，/health とページの読み込みが静まるのを待ち，短い 1 本で温める．
  6. 会話の画面を Edge の独立した窓（--app）で開く．RAM が 32 GB 以下なら「スマホ・タブレットから開くほうが速い」と出す．
     11/15: dsh と中継（3081）が答えるのを待ってから開く．もう開いていれば前に出すだけ（gui_window.ps1）．Edge が無ければ既定のブラウザー．
  7. 起動後の調子（1 窓の内訳）を wintune.py diagnose で 1 行出す．
記録: SYNC_HOME\\run\\last.json（選んだ pack・設定・理由・勧め）と，設定 run\\cfg\\auto.json．
部品の置き場（エンジン・Python・起動の設定のひな形）は sync_home.LAYOUT（入れた先の並びか layout.dev.json）．
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)     # 11/15 S2: wintune.py も同じフォルダーに置く（配布物の launcher の部品に入る）
import wintune  # noqa: E402
import ramsqueeze  # noqa: E402  11/16 係 S4: 起動・モデルの切り替えのとき 1 回，ほかのアプリの RAM を追い出す
import sync_home as H  # noqa: E402  11/15 app1115: 設定・置き場・dsh
import sync_i18n  # noqa: E402  11/17 I-10: 文字だけの画面（TERM=linux）は英語で出す

ROOT = os.path.join(H.home(), "run").replace("\\", "/")   # 11/15 app1115: SYNC_HOME\run（前は results\night-1115\launcher）
LAY = H.LAYOUT
PY = LAY["python"] or sys.executable                  # エンジンの入口（serve の server.py）を流す Python
TEMPLATE = LAY["engine_template"]                     # 起動の設定のひな形（読むだけ）．入れた先では道のりの無いひな形 engine-template.json
ENGINE = LAY["engine_exe"]
# 走りながらエンジンが自分で直す旗（11/15 の夜に測って採ったもの）: RAM の写しを育てる／CPU と GPU の分担を実測の待ちで寄せる／CPU の優先度を「通常以上」に
# 起動の値に足すエンジンの旗は，ここ 1 か所（11/15 夜．例: "STRATA_QL_ACTQ_CPU_ROWS": "…"，"STRATA_QL_FLAGB_SKIP0": "1" は照合と測りの後に）
AUTO_ENV = {"STRATA_QL_RAM_ROTATE": "1", "STRATA_QL_PCIE_AUTO": "1", "STRATA_QL_PRIO_CPU": "above",
            "STRATA_QL_RAM_ELASTIC": "1",
            "STRATA_QL_ACTQ_CPU_ROWS": "1", "STRATA_QL_FLAGB_SKIP0": "1"}   # 11/15 夜: ELASTIC＝メモリの枠の動的化．ACTQ・FLAGB は温度 0 の返事が一致，Sync-S R4 +2〜3%・R7 +1%
GUI_URL = "http://127.0.0.1:3081/m/"
SERVER_PY = LAY["server_py"]
MIN_GAIN = {"sync-m": "4"}         # VRAM の入れ替えの下限（pack ごと．無ければ 3．Windows で測った値）
# 11/15 16:55 本人: Sync-XS が選ばれるのは，大きい pack が全部は載らないとき（RAM 不足でも VRAM 不足でも．on_file_pct の判定）だけ．
# 速度重視で 1 つ小さい pack へ下げるときも Sync-XS へは下げない
NO_SPEED_DOWN_TO = ("sync-xs",)


def load_packs():
    """手元の pack の候補（大きい順．同じ大きさなら表引きなし bih3 が先）．モデルの一覧の models から作る．
    kernel: bih3＝表引きなし（速い），lut＝表引き（作者の PC の layout.dev.json の packs_extra だけ）．pending は入れない"""
    out = []
    for m in H.catalog().get("models", []):
        if m.get("pending") or not m.get("local_dir") or not m.get("experts_gib"):
            continue
        out.append({"id": m["id"], "name": m.get("name", m["id"]), "experts_gib": float(m["experts_gib"]), "kernel": "bih3",
                    "dir": m["local_dir"], "repo": (m.get("hf") or {}).get("repo") or None, "min_gain": MIN_GAIN.get(m["id"], "3"),
                    "fits_ram_gib": float(m.get("fits_ram_gib") or 0),
                    # 11/16 夜: 画面の「おすすめ」（中継の modelsView．11/15 本人「RAM 32 GB でも VRAM が 12 GB 未満なら Sync-XS」）と同じ条件
                    "fits_vram_gib": float(m.get("fits_vram_gib") or 0), "vram_waived_ram_gib": float(m.get("vram_waived_ram_gib") or 0)})
    fits = {c["id"]: c["fits_ram_gib"] for c in out}
    for x in LAY.get("packs_extra") or []:
        out.append({**x, "dir": os.path.normpath(x["dir"]), "min_gain": x.get("min_gain", MIN_GAIN.get(x["id"], "3")),
                    "fits_ram_gib": float(x.get("fits_ram_gib") or fits.get(x["id"], 0))})
    out.sort(key=lambda c: (-c["experts_gib"], c["kernel"] != "bih3"))
    return out


PACKS = load_packs()


def save_choice(pick, relay_port=3081):
    """起動したら choice.json に pack と tail skip を残す（画面が「いま動いているのは Sync-S R4」と出せるように）．
    作者の PC で日常の番号（3081）のときは，日常の中継の choice.json にも残す（layout.dev.json の daily_choice）"""
    rec = {"model": pick["id"], "r": pick["R"], "at": int(time.time() * 1000), "by": "sync_launch"}
    daily = [LAY["daily_choice"]] if LAY.get("daily_choice") and relay_port == 3081 else []
    for f in [H.path("models-state", "choice.json")] + daily:
        try:
            os.makedirs(os.path.dirname(f), exist_ok=True)
            json.dump(rec, open(f, "w", encoding="utf-8"))
        except OSError:
            pass


ON_FILE_OK_PCT = 3.0
TIER_SLACK_GIB = 1.0
# 11/16: 積んでいる量が読めないときの見える量の段（内蔵 GPU の UMA で 2〜4 GiB 減ることがあるので広く）．一覧の fits_ram_gib → 見える量の下限
VISIBLE_TIER_GIB = {24: 0, 32: 27, 48: 43}     # 11/16: RAM の段の余裕（「32 GB」の PC は 約 31.6 GiB と出る．中継の modelsView の fitsOf と同じ 1 GiB）
R_OF = {"speed": 4, "quality": 7}


def say(s):
    s = sync_i18n.t(s)       # 11/17 I-10: 英語の画面なら英語に（日本語の画面は何もしない）
    print(s, flush=True, file=sys.stderr if JSON_OUT else sys.stdout)


PORT = 8080          # API の待ち受け（--port で変える）


def health(port=None):
    port = port or PORT
    if not H.listening(port):     # 11/15 S2: 待ち受けが無ければ聞かない（断られるまでの待ちを省く）
        return False
    # 11/18 W12: 「待ち受け＋/health が 200」だけでは llama-server・Open WebUI（既定 8080）を自分のエンジンと取り違える．
    # 答えが Sync-Strata のエンジンの形（"service": "strata"）か，自分で起こしたエンジン（procs.json の番号が合う．偽の Strata の試し）のときだけ True
    if H.strata_health(port):
        return True
    if (H.procs().get("engine") or {}).get("port") == port and H.alive("engine"):
        try:
            return urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2).status == 200
        except Exception:
            return False
    return False


def listening(port):
    return H.listening(port)      # 11/15 S2: OS の表で見る（つなぎに行かない）


def page_reads():
    if not H.OS.IS_WIN:       # 11/16 S2: Linux は /proc/vmstat の pgmajfault
        import lintune
        return lintune.page_reads(5.0)
    o = wintune.run_ps("$m = Get-Counter '\\Memory\\Page Reads/sec','\\Memory\\Available MBytes' -SampleInterval 5 -MaxSamples 1; "
                       "($m.CounterSamples | ForEach-Object { [math]::Round($_.CookedValue,0) }) -join ' '", 60).split()
    try:
        return float(o[0]), float(o[1])
    except (IndexError, ValueError):
        return None, None


def download_plan(pack):
    """公開版でここに入る手順（今夜は実行しない: 非公開の置き場の鍵を扱わないため）．
    huggingface_hub.snapshot_download(repo_id=pack['repo'], local_dir=<モデルの置き場>/<id>, max_workers=8) → MANIFEST.json の sha256 で確かめる →
    GGUF（語彙・射影）・下書きの層・トークナイザーも同じ形で．途中で切れたら同じ呼び出しで続きから．空きの確かめ（pack＋2 GiB）を先に．"""
    return {"repo": pack.get("repo"), "needs_gib": round(pack["experts_gib"] * 1.08 + 2.5, 1)}


# 11/18 E1（本人の決定）: コミットで枠が削られる PC では，エンジンが写す時に STRATA_RESIDENT_HEADROOM_GIB（ひな形 2）＋0.25 GiB の
# コミットを残し，起動後の空きは約 2.6 GiB になる（知り合いの PC の記録と，11/18 のこの PC の測り: 起動後＝写す時の空き − 枠 ＋ 0.3〜0.5）．
# 会話の預け置きの自動の大きさは (空き − 256 MiB) × 40% が 1,024 MiB 以上でないと off なので，2.75 GiB 要る．
# バッファーありになる PC だけ，エンジンに残させるコミットを 1 GiB 増やし（起動後 約 3.6 GiB → 預け置き 約 1,280 MiB），枠もその分下げる．
# 外れた専門家はファイルのキャッシュから読む．バッファーなしの PC は SSD から読む分が増えて decode が落ちるので下げない（預け置きは off のまま）
CONV_CACHE_EXTRA_GIB = 1.0


def file_tier_buffered(commit_limited, on_file_gib, page_cache_room_gib):
    """11/18 E1: ファイルの側をバッファーありで読むか．コミットで枠が削られ，ファイルの側に専門家が残り，ファイルのキャッシュに
    使える RAM がその半分以上（かつ 2 GiB 以上）あるときだけ（本家 #3237 の境目）"""
    on_file_gib = float(on_file_gib or 0)
    return bool(commit_limited) and on_file_gib > 0 and float(page_cache_room_gib or 0) >= max(2.0, 0.5 * on_file_gib)


def commit_restart(cur, rep):
    """11/18 E1（本人の決定）: 起動の道具はコミットで枠が削られないと見たのに，エンジンがコミットで枠を削った PC（12 GB のカードは
    写す前に VRAM の分のコミットを 8〜13 GiB 取り，ENGINE_COMMIT_GIB の見積もり 2.0 より多い．11/18 のこの PC の測り）．
    コミットで削られた PC として，バッファーあり＋会話の預け置きの分（choose と同じ）で 1 回だけ起こし直す設定を返す．
    起こし直しても変わらない（1 GiB 下げてもバッファーありにならない）なら None（そのまま使う）"""
    if not H.OS.IS_WIN or cur.get("commit_limited") or cur.get("commit_restarted"):
        return None
    if not rep.get("conv_cache_off"):    # 11/18 の通し試験: 預け置きが入っている起動まで起こし直していた（読み込み 1 回と枠 1.24 GiB の損）
        return None
    g = rep.get("granted_budget_gib")      # エンジンの「exceeds available commit」の行だけ（RAM で削った行は数えない）
    b_asked = float(cur.get("budget") or 0)
    if g is None or g + 0.25 >= b_asked:
        return None
    b0 = int(float(g) * 4) / 4.0
    onf0 = float(cur.get("on_file_gib") or 0) + (b_asked - b0)
    b2 = max(0.0, int((b0 - CONV_CACHE_EXTRA_GIB) * 4) / 4.0)
    onf2 = round(onf0 + (b0 - b2), 2)
    pcr2 = round(max(0.0, float(cur.get("ram_room_gib") or 0) - b2), 2)
    if not file_tier_buffered(True, onf2, pcr2):
        return None
    eg = float(cur.get("experts_gib") or 0)
    return dict(budget=b2, commit_limited=True, on_file_gib=onf2, on_file_pct=round(100 * onf2 / eg, 1) if eg else 0.0,
                page_cache_room_gib=pcr2, conv_cache_extra_gib=CONV_CACHE_EXTRA_GIB, conv_cache_short=False)


def choose(pre, preset, want, ram_max=None, reserve_mib=None):
    """pack と設定を決める．理由を日本語の行で返す"""
    g0 = (pre.get("gpus") or [{}])[0]
    display = (g0.get("display_active") or "").lower().startswith("enabled")
    reserve = wintune.reserve_for(float(g0.get("vram_total_mib") or 0) / 1024, display)    # 画面あり VRAM 10 GiB 以上 768・未満 512，なし 512（11/18 の静かな測りで決めた．wintune.reserve_for）
    if reserve_mib is not None:      # 11/15 app1115: 設定 vram_reserve_mib
        reserve = int(reserve_mib)
    avail = pre["ram"].get("avail_if_stopped_gib") or pre["ram"]["avail_gib"]
    vram_free = pre.get("vram_free_assumed_gib") or (g0.get("vram_free_mib") or 0) / 1024
    seats = max(0.0, vram_free - wintune.VRAM_ENGINE_GIB - reserve / 1024)
    room = avail - wintune.ENGINE_RAM_GIB_WIN - wintune.SAFETY_GIB
    # 11/17 G: Windows のコミット（メモリ＋ページファイルの上限）の空きでも枠を決める（エンジンは 空き − 2.25 に削る．知り合いの PC で 16〜19 GiB を頼んで 7〜13 GiB しか取れなかった）
    cfree = pre["ram"].get("commit_free_gib") if H.OS.IS_WIN else None
    commit_room = None if cfree is None else max(0.0, cfree - wintune.ENGINE_COMMIT_GIB - wintune.COMMIT_HEADROOM_GIB)
    cands = []
    for p in PACKS:
        if not os.path.exists(os.path.join(p["dir"], "experts.v2.bin")):
            continue
        # 11/17 G: 頼みたい枠（今までどおり．設定 ram_max_gib があればそれ，無ければ空き RAM から）→ コミットの枠で更に削る
        want_b = max(0.0, min(p["experts_gib"] - seats, float(ram_max) if ram_max is not None else room))
        phys_b = int(want_b * 4) / 4.0
        budget = phys_b if commit_room is None else int(min(want_b, commit_room) * 4) / 4.0
        on_file = max(0.0, p["experts_gib"] - seats - budget)
        cands.append({**p, "budget": budget, "budget_physical": phys_b, "commit_limited": budget < phys_b,
                      "on_file_gib": round(on_file, 2), "on_file_pct": round(100 * on_file / p["experts_gib"], 1)})
    why = [f"空き RAM {avail:.1f} GiB（エンジンに {wintune.ENGINE_RAM_GIB_WIN}，余白 {wintune.SAFETY_GIB} を除くと専門家に {room:.1f} GiB），VRAM の席 約 {seats:.1f} GiB，画面は{'この GPU' if display else '別／なし'}（予約 {reserve} MiB）"]
    if not cands:
        return None, why + ["手元に pack が無い（公開版ではここでダウンロード）"]
    if want != "auto":
        pool = [c for c in cands if c["id"] == want] or cands
        pick = pool[0]
        why.append(f"pack は指定どおり {pick['name']}")
    else:
        # 11/16 本人の決定: 積んでいる RAM（物理の合計）の段で選ぶ（画面の説明「Sync-XS RAM 24GB 以下向け／Sync-S RAM 32GB 向け／
        # Sync-M RAM 48GB 以上向け」と同じ．一覧の fits_ram_gib．「32 GB」の PC は 約 31.6 GiB と出るので 1 GiB の余裕＝中継の modelsView と同じ）．
        # 空き RAM が足りないときも小さいモデルには落とさない（SSD に残る割合と，閉じると戻る RAM を出す）
        ram_total = float(pre["ram"].get("total_gib") or 0)          # 見える量（内蔵 GPU の UMA などの分だけ減る）
        ram_inst = pre["ram"].get("installed_gib")                     # 積んでいる量（11/16: 段はこれで）
        if ram_inst:
            tier = [c for c in cands if c.get("fits_ram_gib", 0) <= float(ram_inst) + TIER_SLACK_GIB]
            seen = f"積んでいる RAM {float(ram_inst):.0f} GB（見える量 {ram_total:.1f} GiB）"
        else:   # 積んでいる量が取れないとき: 見える量で，余裕を広く（S は 27 GiB・M は 43 GiB から）
            tier = [c for c in cands if VISIBLE_TIER_GIB.get(int(c.get("fits_ram_gib", 0)), c.get("fits_ram_gib", 0) - 5) <= ram_total]
            seen = f"見える RAM {ram_total:.1f} GiB（積んでいる量は読めなかった）"
        # 11/16 夜 本人の確かめ: VRAM の条件も画面の「おすすめ」（中継 server.mjs の modelsView の vramShort）と同じに．
        # 一覧の fits_vram_gib（例 Sync-S は 12）より VRAM の総量が 0.5 GiB 以上少なければ，その段から外す
        # （RAM が vram_waived_ram_gib（例 48）以上ならこの条件は要らない．VRAM が分からないとき（0）は RAM だけで決める）
        vram_total = float(g0.get("vram_total_mib") or 0) / 1024
        ram_for_waive = float(ram_inst) if ram_inst else ram_total + 1
        def vram_short(c):
            need = c.get("fits_vram_gib") or 0
            waive = c.get("vram_waived_ram_gib") or 0
            return vram_total > 0 and need > 0 and vram_total + 0.5 < need and not (waive and ram_for_waive + 1 >= waive)
        short = [c for c in tier if vram_short(c)]
        if short:
            tier = [c for c in tier if not vram_short(c)]
            seen += f"，VRAM {vram_total:.1f} GiB（{'・'.join(c['name'] for c in short)} は VRAM {short[0]['fits_vram_gib']:.0f} GB 以上向け）"
        if tier:
            pick = tier[0]          # 大きい順に並んでいるので，段に合ういちばん大きい物
            why.append(f"{seen} なので {pick['name']}（RAM {pick.get('fits_ram_gib', 0):.0f} GB 向け）")
        else:
            pick = min(cands, key=lambda c: (c["experts_gib"], c["kernel"] != "bih3"))
            why.append(f"{seen} に合う段のモデルが手元に無いので，手元のいちばん小さい {pick['name']}")
        if preset == "speed":       # 速度重視: 1 つ小さい物（同じ段の中．Sync-XS へは下げない＝11/15 16:55 本人）
            smaller = [c for c in tier if c["experts_gib"] < pick["experts_gib"] and c["kernel"] == "bih3" and c["id"] not in NO_SPEED_DOWN_TO]
            if smaller:
                pick = smaller[0]
                why.append(f"速度重視なので 1 つ小さい {pick['name']}")
        if pick["on_file_pct"] > ON_FILE_OK_PCT and not pick.get("commit_limited"):
            why.append(f"いまは空き RAM が足りず，{pick['name']} の専門家の {pick['on_file_pct']}%（{pick['on_file_gib']} GiB）が SSD に残る"
                       f"（会話のたびに SSD を待つので遅くなる．閉じられるアプリを閉じると 約 {pre.get('closable_gib')} GiB 戻る）．小さいモデルには替えない")
        else:
            why.append(f"{pick['name']} は全部 RAM と VRAM に載る（SSD に残る {pick['on_file_pct']}%）")
    pick = dict(pick)
    pick.update(reserve=reserve, R=R_OF.get(preset, 7), seats_gib=round(seats, 2))
    # 11/18 E1（本人の決定）: 枠に入らずファイルの側に残る専門家を Windows のファイルのキャッシュに置ける RAM（空き RAM から
    # エンジンの分・余白・枠を引いた残り）．ファイルのキャッシュはコミットに数えられないので，コミットで枠が削られた PC でも使える
    pick["page_cache_room_gib"] = round(max(0.0, room - float(pick.get("budget") or 0)), 2)
    pick["ram_room_gib"] = round(max(0.0, room), 2)   # 11/18 E1: commit_restart が使う
    # 11/18 E1（本人の決定）: 会話の預け置きの分のコミット（CONV_CACHE_EXTRA_GIB の説明）
    pick["conv_cache_extra_gib"] = 0.0
    pick["conv_cache_short"] = False
    if H.OS.IS_WIN and pick.get("commit_limited"):
        _b0 = float(pick.get("budget") or 0)
        _b2 = max(0.0, int((_b0 - CONV_CACHE_EXTRA_GIB) * 4) / 4.0)
        _onf2 = round(float(pick.get("on_file_gib") or 0) + (_b0 - _b2), 2)
        _pcr2 = round(max(0.0, room - _b2), 2)
        if file_tier_buffered(True, _onf2, _pcr2):
            pick.update(budget=_b2, on_file_gib=_onf2, on_file_pct=round(100 * _onf2 / pick["experts_gib"], 1),
                        page_cache_room_gib=_pcr2, conv_cache_extra_gib=CONV_CACHE_EXTRA_GIB)
        else:
            pick["conv_cache_short"] = True
    if ram_max is not None:
        why.append(f"RAM の枠は設定どおり {ram_max} GiB まで")
    if reserve_mib is not None:
        why.append(f"VRAM の予約は設定どおり {reserve_mib} MiB")
    why.append(f"RAM の枠 {pick['budget']} GiB，輪なし")
    pick["limits"] = {"physical_budget_gib": pick.get("budget_physical"), "commit_budget_gib": None if commit_room is None else int(commit_room * 4) / 4.0,
                      "commit_free_gib": cfree, "binding": "commit" if pick.get("commit_limited") else "ram_or_setting",
                      "formula": "min(pack−席, 空きRAM−2.7−2.25, コミットの空き−2.0−2.25)"}
    if reserve_mib is None and reserve != (wintune.DISPLAY_RESERVE_MIB if display else wintune.HEADLESS_RESERVE_MIB):
        why.append(f"VRAM が少ないので、予約を {reserve} MiB にしました。")      # 11/17 G: 画面に出す文は「、。」
    why.extend(commit_notes(pick, pre, cfree))
    return pick, why


def commit_notes(pick, pre, cfree):
    """11/17 G: 枠をコミットで下げたときの，理由・SSD に残る量・手当て・コミットの多いアプリ（画面に出す文．短く，句読点は「、。」）"""
    if not pick.get("commit_limited"):
        return []
    out = [f"メモリの枠を {pick['budget_physical']} GiB から {pick['budget']} GiB に下げました。Windows のメモリの上限（コミット）の空きが {cfree} GiB しかないためです。"]
    if pick["on_file_pct"] > ON_FILE_OK_PCT:
        out.append(f"専門家の {pick['on_file_pct']}% が SSD に残ります。会話が遅くなることがあります。")
    pf = pre.get("pagefile_total_gib")
    out.append("ページファイルを「システム管理」にすると、枠を戻せます。" + (f"（いまは {pf} GiB）" if pf is not None else ""))
    top = [a for a in (pre.get("commit_top") or []) if a.get("private_gib", 0) >= 0.5][:3]
    if top:
        out.append("コミットの多いアプリを閉じても戻せます。" + "、".join(f"{a.get('label') or a['name']} {a['private_gib']} GiB" for a in top) + "。")
    return out


def apply_squeeze(s, dry=False, say_=None):
    """11/16 係 S4（本人の決定）: 設定 ram_squeeze が auto（既定）なら，エンジンが止まっている今（起動の前，または画面からモデルを切り替えるとき＝
    中継が down --engine の後に up --gui --model を呼ぶ道で，前のエンジンを止めた後・新しいのを起こす前）に 1 回だけ追い出す．
    アプリは閉じない．off なら何もしない．--dry は試し用の値（SYNC_FAKE_SQUEEZE）があるときだけ流す．戻り値は ramsqueeze.run の辞書"""
    mode = s.get("ram_squeeze") or "auto"
    if mode == "off":
        return ramsqueeze.run("off")
    if dry and not os.environ.get("SYNC_FAKE_SQUEEZE"):
        return {"ran": False, "mode": mode, "freed_gib": 0.0, "why": None, "detail": "--dry なので追い出しません"}
    (say_ or say)("  ほかのアプリの RAM を追い出しています（10〜30 秒ほど．アプリは閉じません）...")
    tg = os.environ.get("SYNC_RAM_SQUEEZE_TARGET_GIB")
    return ramsqueeze.run(mode, float(tg) if tg else 3.0)


def api_info(host, port, key_set):
    """ほかのハーネス・自作の道具からつなぐための案内（OpenAI 互換・Anthropic 互換）"""
    base = f"http://{host if host not in ('0.0.0.0', '::') else '<この PC の番地>'}:{port}"
    model = "strata"
    try:
        hdr = {"Authorization": "Bearer " + os.environ.get("STRATA_API_KEY", "")} if key_set else {}
        m = json.loads(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/v1/models", headers=hdr), timeout=5).read())
        model = (m.get("data") or [{}])[0].get("id", model)
    except Exception:
        pass
    key = "起動のときに渡した鍵（環境変数 STRATA_API_KEY）" if key_set else "なし（何を入れても通る）"
    # 例は英字だけにする: Windows の端末から日本語を -d に直接書くと，端末の文字コード（cp932）のまま送られて server に断られる（11/15 に実際に起きた）
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": "Hello"}]}).replace('"', '\\"')
    return [
        f"API: {base}/v1   モデル名: {model}",
        f"  OpenAI 互換: POST {base}/v1/chat/completions（stream 可），POST /v1/responses，GET /v1/models",
        f"  Anthropic 互換: POST {base}/v1/messages（stream 可）",
        f"  鍵: {key}．送り方は Authorization: Bearer <鍵> か x-api-key: <鍵>",
        f"  多くのハーネスは環境変数で: OPENAI_BASE_URL={base}/v1  OPENAI_API_KEY=<鍵>（Anthropic 形式なら ANTHROPIC_BASE_URL={base}）",
        f'  curl の例: curl {base}/v1/chat/completions -H "Content-Type: application/json" -d "{body}"',
        "  日本語を curl で送るとき（Windows）: 本文を UTF-8 のファイルに書いて --data-binary @body.json（端末に直接書くと文字コードが合わず断られる）",
        '  速さと品質を依頼ごとに変える: 本文に "strata_tune": {"tail_skip": 4}（速度重視）／7（品質重視）／0（切）．無ければ起動のときの preset',
    ]


# 11/16: RAM の写しのうち固定する量（STRATA_PARTIAL_PIN_GIB）．Windows は「枠＋1」（今のまま）．Linux は「枠 − 帯」，
# 帯＝min(BAND_MAX_GIB, 枠 × BAND_FRAC)（メモリの枠の動的化を Linux でも働かせるため．本人の答え次第で変わるので，値はこの表の 1 か所）
PIN_RULE = {"windows": {"plus_gib": 1}, "linux": {"band_max_gib": 4.0, "band_frac": 0.2}}


def pin_gib(budget):
    if H.OS.IS_WIN:
        return str(int(budget + PIN_RULE["windows"]["plus_gib"]))
    r = PIN_RULE["linux"]
    band = min(r["band_max_gib"], budget * r["band_frac"])
    return f"{max(0.0, budget - band):.2f}".rstrip("0").rstrip(".") or "0"


def learned_profile(model_id):
    """学習した専門家の並びの置き場（11/16．モデルごと）"""
    return H.path("engine-data", f"expert-profile-{model_id}.bin")


def make_config(pick, engine, extra_env, context=None):
    c = json.load(open(TEMPLATE, encoding="utf-8"))
    args = list(c["args"])
    # 11/15 S2: 入れた先のひな形（engine-template.json）は道のりを持たない．置き場はここで入れる
    if LAY.get("engine_lib_dirs"):
        c["lib_dirs"] = LAY["engine_lib_dirs"]
    if LAY.get("engine_cwd"):
        c["cwd"] = LAY["engine_cwd"]
    if LAY.get("expert_profile"):
        if "--expert-profile" in args:
            args[args.index("--expert-profile") + 1] = LAY["expert_profile"]
        else:
            args += ["--expert-profile", LAY["expert_profile"]]
    # 11/20 0.1.3（本人の決定）: 設定 refusal_reduction が on なら，拒否を減らす制御ベクトルを読み込む（本家 Strata の
    # Experimental speed projection と同じ引数．頼みの "experimental_speed_projection": false で頼みごとに切れる）
    if H.effective().get("refusal_reduction") == "on" and LAY.get("refusal_vector"):
        args += ["--control-vector-scaled", LAY["refusal_vector"] + ":1.0", "--control-vector-layer-range", "4", "44",
                 "--cvec-mode", "project", "--cvec-dir", "per-layer"]
    sp0 = H.shared_paths()
    if LAY.get("vision_exe") and "vision.mmproj" in sp0 and not isinstance(c.get("vision"), dict):
        # 11/15 夜: 入れた先のキットに画像の読み取りのエンジンがあり，mmproj が手元にあれば画像を読む（無ければ下で外す）
        # 11/17 本人: 解像度を 750 くらいに落として読み取りを速く．画面の attach.js も長い辺 768 px に（strata-desktop が直した）．
        # 768×768 px ÷ 16 px の区切り × 2×2 で 32 px が 1 トークン → 24×24＝576（768 は mmproj の clip.vision.image_size）．以前は 1024
        c["vision"] = {"exe": LAY["vision_exe"], "mmproj": sp0["vision.mmproj"], "model": sp0.get("vision.model") or sp0.get("--native"),
                       "gpu": False, "max_tokens": 576, "threads": 8, "elastic": True, "elastic_idle_s": 120}
        if "--vision" not in args:
            args.append("--vision")
    vis = c.get("vision")
    if isinstance(vis, dict) and not (vis.get("exe") and os.path.exists(vis["exe"])):
        c.pop("vision", None)           # 画像の読み取りのエンジンが無い並び（配布物の今の版）では画像を読まない
        args = [x for x in args if x != "--vision"]

    def setarg(k, v):
        if k in args:
            args[args.index(k) + 1] = v
        else:
            args.extend([k, v])
    setarg("--pack", pick["dir"])
    setarg("--resident-budget-gib", str(pick["budget"]))
    setarg("--vram-reserve-mib", str(pick["reserve"]))
    setarg("--adapt-min-gain", str(pick.get("min_gain", "3")))
    if context:
        setarg("--max-context", str(int(context)))   # 11/15 app1115: 設定 context
    if pick.get("kv_format"):
        setarg("--kv", pick["kv_format"])   # 11/15 係 C: 設定 kv_format（--kv-grow はひな形のまま．--kv-streaming は使わない）
    sp = H.shared_paths()                            # 11/15 app1115: 一覧の共通の部品があれば，その置き場を使う
    for flag in ("--native", "--ple-gguf", "--mtp"):
        if flag in sp:                               # 11/15 S2: ひな形に無い旗（道のりの無いひな形）も足す
            setarg(flag, sp[flag])
    if "tokenizer" in sp:
        c["tokenizer"] = sp["tokenizer"]
    if "vision.model" in sp and isinstance(c.get("vision"), dict):
        c["vision"]["model"] = sp["vision.model"]     # 11/15 夜: 画像の読み取りの --model も共通の部品の GGUF（切り出した物）
    if "vision.mmproj" in sp and isinstance(c.get("vision"), dict):
        c["vision"]["mmproj"] = sp["vision.mmproj"]   # 11/15: VRAM の入れ替えの下限（既定 1.5）．pack ごとの値（PACKS の min_gain．無ければ 3）
    try:                                             # 11/16 係 S3: Windows の Radeon（HIP）は backend=hip と，単体の装置の番号（内蔵があると単体は 1 にずれる＝上流 #325）を渡す
        import sync_env as _SE
        _ev = _SE.check()
        if _ev["gpu"].get("vendor") == "nvidia" and _ev["gpu"].get("index") is not None:
            c["gpu"] = int(_ev["gpu"]["index"])      # 11/18: 選んだ NVIDIA の GPU の番号（nvidia-smi の番号．server.py が CUDA_DEVICE_ORDER=PCI_BUS_ID で渡す）
        if _ev["gpu"].get("vendor") == "amd" and _ev["engine"]:     # 11/18 係 A1: Linux の Radeon も（前は Windows だけ．Linux はひな形の "gpu": 0 が残り，内蔵 GPU のある PC で 0 番＝内蔵で起きうる）
            c["backend"] = "hip"
            # 11/16 エンジン 1: ひな形の "gpu": 0 が残ると，番号が取れなかったとき HIP_VISIBLE_DEVICES=0（内蔵）で起きて落ち，
            # server.py の起動ごとの自動の選び（hip_auto_devices）も働かない．HIP では外し，番号が取れたときだけ渡す
            c.pop("gpu", None)
            c.pop("gpus_asked", None)
            _ord = _SE.hip_ordinal(engine, c.get("lib_dirs"))
            if _ord is not None:
                c["hip_ordinal"] = _ord
    except Exception:
        pass
    env = dict(c.get("env") or {})
    # 11/18 E1（本人の決定）: ファイルの側は今までどおり SSD から直接読む（STRATA_UNBUFFERED_LOAD=1）．ただしコミットの空きで
    # RAM の枠が削られ（commit_limited），空き RAM がファイルの側に残る量の半分以上かつ 2 GiB 以上あるときは，バッファーを通して
    # 読む（=0: Windows のファイルのキャッシュはコミットに数えられず，2 回目からはファイルの側も RAM から読める．知り合いの PC:
    # 枠が 12〜13 GiB に削られ空き RAM 22 GiB）．コミットが足りるふだんの PC は今と同じ
    _onf = float(pick.get("on_file_gib") or 0)
    _pcr = float(pick.get("page_cache_room_gib") or 0)
    _buffered = file_tier_buffered(pick.get("commit_limited"), _onf, _pcr)
    if isinstance(pick.get("limits"), dict):
        pick["limits"]["file_tier_read"] = ("buffered" if _buffered else "unbuffered")
        pick["limits"]["page_cache_room_gib"] = _pcr
    env.update(STRATA_ROUTE_TAIL_SKIP=str(H.engine_tail(pick["R"])), STRATA_QL_DYN_TIER_GIB="0", STRATA_UNBUFFERED_LOAD=("0" if _buffered else "1"),
               STRATA_PARTIAL_PIN_GIB=pin_gib(pick["budget"]))
    env.update(AUTO_ENV)
    # 11/20 0.1.3: 自動の調整（STRATA_QL_PCIE_AUTO）が落ち着いた割合をホストの run に覚え，次の起動はそこから始める
    # （エンジンが pack・GPU・pcie-mode などのキーで照らし合わせる．古いエンジンはこの変数を読まないだけ）
    env.setdefault("STRATA_QL_PCIE_AUTO_STATE", H.path("run", "pcie-share.json"))
    if _buffered and float(pick.get("conv_cache_extra_gib") or 0) > 0:   # 11/18 E1: 会話の預け置きの分のコミットをエンジンに残させる
        try:
            _hr = float(env.get("STRATA_RESIDENT_HEADROOM_GIB") or 2)
        except ValueError:
            _hr = 2.0
        env["STRATA_RESIDENT_HEADROOM_GIB"] = f"{_hr + float(pick['conv_cache_extra_gib']):g}"
        if isinstance(pick.get("limits"), dict):
            pick["limits"]["conv_cache_extra_gib"] = float(pick["conv_cache_extra_gib"])
    if _buffered:   # 11/18 E1: ひな形の STRATA_QL_KEEP_UNBUFFERED=1（起動後も experts.v2.bin をマッピングし直さない）が
        env["STRATA_QL_KEEP_UNBUFFERED"] = "0"   # UNBUFFERED_LOAD=0 より強く効き，ファイルの側が直接読みのままだった（11/18 の測りで確認）
    try:      # 11/18: Pascal（cc 6.x．CUDA 12 のキット）は，答えを変えずに prompt の読みを速くする本家の 2 つの旗を入れる
        import sync_env as _SE2   # （STRATA_PATTN_SM60＝int8 K/V の prompt の注意を 1 本の核で．STRATA_DENSE_F32＝密な投影を cublasSgemm で．どちらも本家が P40 で測った）．
        _g2 = _SE2.check()["gpu"]  # STRATA_QL_GDN_KH_SM6X は Pascal で測っていないので入れない．V100（cc 7.0）は対象外
        if _g2.get("vendor") == "nvidia" and 0 < float(_g2.get("cc") or 0) < 7.0:
            env.setdefault("STRATA_PATTN_SM60", "1")
            env.setdefault("STRATA_DENSE_F32", "1")
    except Exception:
        pass
    if c.get("backend") == "hip":   # 11/19: Radeon（HIP・ROCm）は GPU の処理の順番の競合がある（内蔵 Radeon gfx1036 で返事が全部 0・本番の道は
        # メモリー違反で落ちる．11/19 の Linux メイン機での切り分け）．カーネルを投げた後に終わるまで待つ
        # AMD_SERIALIZE_KERNEL=2 で毎回同じ返事になり，0・落ちが消えた（prefill +4〜5%，decode は下書きの当たりが上がり速くなった）．
        # 直すまでの避け方として既定に．--env AMD_SERIALIZE_KERNEL=0 で外せる
        # 11/19 0.1.2（本人「単体の Radeon の decode も出来る限りの対策を」）: Radeon は PCIe 越しに RAM の専門家を受け取るのが遅い
        # （GitHub の Issue #2 の RX 9070 XT の方: decode の窓 63〜86 ms のうち 42〜64 ms が PCIe の分の待ち，自動の調整が 0.70→0.57→0.45 と
        # 下げ続けていた）．自動の調整（STRATA_QL_PCIE_AUTO，0.199〜1.0）はそのまま働くので，始める値だけ 0.7 から 0.4 に下げる
        # 11/20 0.1.3（本人 OK）: 0.4 は Windows だけ．Linux の RX 7800 XT（GitHub Issue #3）で短い文の decode が 0.1.1 の 90・94 から
        # 54・59 tok/s に落ちた（0.4 から自動の調整が戻りきる前に頼みが終わる見込み）ので，Linux は 0.1.1 と同じ 0.7 から始める
        if os.name == "nt" and "--pcie-frac" in args and args[args.index("--pcie-frac") + 1] == "0.7":
            setarg("--pcie-frac", "0.4")
        # 11/19 0.1.2（本人の判断，確認箱）: RAM の専門家の置き場の取り方を起動時に測る STRATA_HIP_ARENA=auto（エンジン d278210e）は，
        # 内蔵 Radeon では Windows・Linux とも古い中身の試験が判定できず切り替わらず，起動が 6〜10 秒延びた．効き目の見込みが立つまで
        # 既定は今までどおりの取り方（coherent）．--env STRATA_HIP_ARENA=auto で試せる
        env.setdefault("STRATA_HIP_ARENA", "coherent")
        if os.name == "nt":
            # 11/19 0.1.2（本人の決定）: Windows の Radeon は別の既定．GitHub の Issue #2 の RX 9070 XT（RDNA4）の方の切り分け:
            # ① VMM（hipMemAddressReserve・hipMemMap）が全部失敗して起動できない（RX 9060 XT の方も同じ）→ STRATA_HIP_VMM=0
            # （専門家の置き場は hipMalloc，K/V は固定の割り当て），② AMD_SERIALIZE_KERNEL=2 では最初の頼みでホストが固まり見張りも
            # 働かない，=0 では層 1 の待ちで時間切れ → STRATA_QL_DMA_GPUFLAG=0（flag B をホストの関数で上げる）で解消．
            # この 3 つで Sync-XS が動いた（相手の実機）．どれも --env で上書きできる
            env.setdefault("AMD_SERIALIZE_KERNEL", "0")
            env.setdefault("STRATA_HIP_VMM", "0")
            # （STRATA_QL_DMA_GPUFLAG=0 は下で NVIDIA と一緒に．ひな形が "1" を持つので setdefault では効かなかった）
        else:
            env.setdefault("AMD_SERIALIZE_KERNEL", "2")
    if os.name == "nt" and env.get("STRATA_QL_DMA_GPUFLAG") == "1":
        # 11/19 0.1.2: Windows（WDDM）では，flag B を GPU のカーネルでコピーのストリームに上げる道（--pcie-mode dma ＋ STRATA_QL_DMA_GPUFLAG=1，
        # ひな形の既定）が窓のグラフと待ち合い，最初の頼みで『verify: timed out at layer 1（#267）』→ エンジンが止まる PC がある
        # （GitHub の Issue #2 の RTX 4060・RTX 4070・RX 9070 XT，X の RTX 4070 Ti．4070 Ti の方と RX 9070 XT の方が =0 で直ることを実機で確かめた．
        # 係 R2 の読み: verify.cpp 3929 の raise_flagB）．=0 は flag B をホストで上げる．この PC（RTX 3080）の dchat（Sync-XS・R4・6 本）では
        # 90.7 → 90.3 tok/s で差は揺れの範囲．Linux は今のまま．--env STRATA_QL_DMA_GPUFLAG=1 で前に戻せる
        env["STRATA_QL_DMA_GPUFLAG"] = "0"
    for kv in extra_env:
        k, _, v = kv.partition("=")
        env[k] = v
    os.makedirs(f"{ROOT}/cfg", exist_ok=True)
    log = os.path.normpath(f"{ROOT}/strata-auto.log")    # 11/16: Windows は「\」，Linux は「/」のまま（前は Linux でも「\」に替えて 1 つのファイル名になっていた）
    c["model_name"] = "qwen3.8-flash-next-" + pick["id"]      # API の /v1/models に出る名前を，実際に読み込む pack に合わせる
    c["aliases"] = [c["model_name"]] if c.get("aliases") else []   # 11/18 係 A2: ひな形の別名は sync-s 固定だった（XS・M でも /v1/models に sync-s が並んだ）
    # 11/16: 会話の中継の SESSION_DIR と同じ置き場（前は別で，中継が古い控えを消せなかった）．新しい sync_home が無ければ前のまま
    slots = H.effective().get("sessions_dir") or LAY.get("slot_save_path") or os.path.dirname(H.path("engine-sessions", "x"))
    os.makedirs(slots, exist_ok=True)
    c.update(args=args, env=env, exe=engine, log=log, port=PORT, slot_save_path=slots,
             note="起動の道具（launcher/sync_launch.py）が作った設定")
    # 11/16 本人の決定: 専門家の並びを各自の PC で学習させる．保存はモデルごとに SYNC_HOME の下（配布物には入らない）．
    # server.py（#477）が，保存した物が同じモデルの形ならそれを読み，そうでなければ --expert-profile（本家の物）を読む
    # 11/16 測りの後: 学習した並びは速くならなかったので既定は off（設定 expert_learning＝on のときだけ学習・保存する）
    if "--expert-profile" in args and (H.effective().get("expert_learning") or "off") == "on":
        c["expert_profile_save"] = learned_profile(pick["id"])
        c["expert_profile_save_every"] = 10
    # 11/16 夜 本人の決定（エンジン 1 の切り分け）: 取り出しの値を送らない依頼（dsh は温度も送らない＝greedy）に，
    # 繰り返しの罰則の既定を入れる．dsh の長い文脈＋greedy＋R4 で名詞の並びが輪に落ちた（同じ文 101 回・思考 51,000 字）のが，
    # repetition 1.05（直前 256）で消え，decode は揺れの内．依頼が自分の値を送れば，そちらが勝つ（server.py sampling_defaults_from_config）
    # モデルごとの強さ（11/16 20:2x: Sync-XS は 1.05 で効ききらず，1.10 を試して決める．決まるまでは全部 1.05）
    REP_PENALTY = {"sync-xs": 1.05, "sync-s": 1.05, "sync-m": 1.05}
    samp = dict(c.get("sampling") or {})
    samp.setdefault("repetition_penalty", REP_PENALTY.get(pick["id"], 1.05))
    samp.setdefault("penalty_last_n", 256)
    c["sampling"] = samp

    path = f"{ROOT}/cfg/auto.json"
    json.dump(c, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return path, log


def find_edge():
    """Edge の場所: いつもの 2 か所，無ければレジストリの App Paths"""
    pf = [os.environ.get(k) for k in ("ProgramFiles(x86)", "ProgramFiles")]   # 11/15 夜: ドライブの道のりを書かない
    for edge in [os.path.join(x, "Microsoft", "Edge", "Application", "msedge.exe") for x in pf if x]:
        if os.path.exists(edge):
            return edge
    try:
        import winreg
        for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(root, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe") as k:
                    p = winreg.QueryValue(k, None)
                    if p and os.path.exists(p.strip('"')):
                        return p.strip('"')
            except OSError:
                pass
    except ImportError:
        pass
    return None


def gui_window(focus=False):
    """会話の画面の窓（題名が dsh のブラウザーの窓）が開いていれば True．focus なら最小化を戻して前に出す（gui_window.ps1）"""
    if not H.OS.IS_WIN:
        return False        # 11/16 S2: Linux では窓を探さない（開くたびに既定のブラウザーへ渡す）
    cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", os.path.join(HERE, "gui_window.ps1")]
    if focus:
        cmd.append("-Focus")
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=0x08000000).stdout.decode("utf-8", "replace")
    except Exception:
        return False
    return out.strip().startswith("found")


def open_gui(dry=False, url=None):
    url = url or f"http://127.0.0.1:{H.effective()['relay_port']}/m/"      # 11/18 W12: 番号は設定から（前は 3081 固定）
    """会話の画面を開く．11/15 の直し: もう開いていれば前に出すだけ（二重に開かない），Edge を App Paths でも探す，
    Edge が無ければ既定のブラウザー．Edge はいつものプロファイル（ふだんのタブと同じログインのクッキーを使う）の独立した窓（--app）．
    返すのは何をしたかの 1 行．dry: 開かずに，何をするかだけ返す"""
    if gui_window(focus=not dry):
        return "会話の画面はもう開いています（前に出しました）" if not dry else "会話の画面はもう開いている（前に出すだけ）"
    edge = find_edge() if H.OS.IS_WIN else None
    if dry:
        return f"Edge の窓で開く（{edge}）" if edge else f"既定のブラウザーで開く（{url}）"
    if edge:
        subprocess.Popen([edge, f"--app={url}", "--window-size=1280,860", "--no-first-run", "--no-default-browser-check"],
                         creationflags=0x00000008, close_fds=True)   # DETACHED_PROCESS
        return "会話の画面を Edge の窓で開きました"
    H.OS.open_url(url)
    return "会話の画面を既定のブラウザーで開きました" + ("（Edge が見つかりませんでした）" if H.OS.IS_WIN else "")


LOGIN_HINT = ("  ログインを求められたら: dsh の黒い窓の http://127.0.0.1:3080/?token=… の頭を http://127.0.0.1:3081 に替えて，"
              "Edge のふつうのタブで 1 回開く（30 日もつ．同じ Edge の窓にも効く）")


def warm(R, key=""):
    body = {"model": "strata", "stream": False, "max_tokens": 48, "temperature": 0.7, "reasoning_effort": "none",
            "chat_template_kwargs": {"enable_thinking": False}, "strata_tune": {"tail_skip": H.engine_tail(R)},
            "strata_checkpoint": False,   # 11/18 夕: 1 回きり＝会話の預け置きに入れない（実測で 1 つ 236 MB を取っていた）
            "messages": [{"role": "user", "content": "こんにちは．準備はできましたか？"}]}
    hdr = {"Content-Type": "application/json"}
    if key:
        hdr["Authorization"] = "Bearer " + key
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/chat/completions", data=json.dumps(body).encode(), headers=hdr)
    try:
        urllib.request.urlopen(req, timeout=300).read()
        return True
    except Exception:
        return False


def write_head_name(name=None):
    """11/18 W11: run\\head-model-name.txt に「Qwen3.8-Flash-Next <モデルの表示名>」を 1 行で書く（中継が頼みごとに読んで，dsh の頭の
    「strata-rN」をこの名前に替える）．name が None なら models-state\\choice.json の model（前の起動が残した id）から表示名を引く．
    分からなければ書かない（前のファイルのまま）．中身が同じなら書き直さない．書けなくても起動は続ける"""
    try:
        if name is None:
            mid = json.load(open(H.path("models-state", "choice.json"), encoding="utf-8")).get("model")
            name = next((c["name"] for c in PACKS if c["id"] == mid), None)
        if not name:
            return
        text = f"Qwen3.8-Flash-Next {name}\n"
        f = f"{ROOT}/head-model-name.txt"
        if os.path.exists(f) and open(f, encoding="utf-8").read() == text:
            return
        os.makedirs(ROOT, exist_ok=True)
        open(f, "w", encoding="utf-8", newline="").write(text)
    except Exception:
        pass


WARM_USER = "こんにちは．"      # 頭の温めの user の発言（短く．本物の頼みの頭は，最初の user の発言の前まで）


def head_warm_body():
    """11/18 W11: 会話の中継が記録した dsh の頭（run\\warm-head.json．system の文・道具の定義・頭の形を変える引数）に，短い user の発言を足した
    温めの頼みの本体．最も使われた頭を選ぶ．記録が無い・読めない・形が違えば None（今の温めのまま）"""
    try:
        j = json.load(open(f"{ROOT}/warm-head.json", encoding="utf-8"))
        hs = [h for h in j.get("heads", []) if isinstance(h, dict) and isinstance(h.get("body"), dict)
              and h["body"].get("messages") and h["body"].get("tools")]
        if not hs:
            return None
        h = max(hs, key=lambda x: (x.get("count", 0), x.get("last", "")))
        body = dict(h["body"])
        body["messages"] = list(body["messages"]) + [{"role": "user", "content": WARM_USER}]
        # 11/18 夕: 続きの来ない 1 回きり（ckpt=0）＝会話の預け置きに入れない．頭の終わりの checkpoint（根）は作られる（エンジン 1 の確認）
        body.update(stream=False, max_tokens=1, strata_checkpoint=False)
        return body
    except Exception:
        return None


def warm_head(s, key=""):
    """11/18 W11: dsh の本物の頭で温める．会話の中継（dsh と同じ宛先）へ x-sync-warm の頼みを送ると，中継が受け付けて（202）順番に
    エンジンへ送る＝起動の道具は待たない（本物の頼みはその後ろに並び，頭が読み終われば使い回せる）．
    返すのは (送ったか, 理由の 1 語)．記録が無い・中継が古い／止まっている／断られたときは (False, …)＝何もしない"""
    body = head_warm_body()
    if body is None:
        return False, "no-record"
    pp = s["proxy_port"]
    try:
        st = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{pp}/proxy/status", timeout=5).read().decode("utf-8", "replace"))
    except Exception:
        return False, "no-proxy"
    if not st.get("warm_head"):
        return False, "old-proxy"      # 古い中継は x-sync-warm を知らず，頼みが終わるまで返らない
    hdr = {"Content-Type": "application/json", "x-sync-warm": "1"}
    if key:
        hdr["Authorization"] = "Bearer " + key
    req = urllib.request.Request(f"http://127.0.0.1:{pp}/v1/chat/completions", data=json.dumps(body).encode(), headers=hdr)
    try:
        return urllib.request.urlopen(req, timeout=15).status == 202, "queued"
    except Exception:
        return False, "refused"


def stop_engine(port):
    """エンジンを止める（11/15 app1115）．自分で起こした偽物・ほかの物（procs.json の engine）は番号で，
    本物（serve\\server.py）は stop-strata.ps1 で（-Port を渡す）．止めたら 0"""
    rec = H.procs().get("engine")
    if rec and H.alive("engine") and not rec.get("real"):
        H.stop("engine")
        for _ in range(40):
            if not listening(port):
                return 0
            time.sleep(0.25)
        return 1
    if not listening(port):
        H.stop("engine")
        return 0
    if LAY.get("stop_ps1") and os.path.exists(LAY["stop_ps1"]):
        r = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", LAY["stop_ps1"], "-Port", str(port)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
        H.stop("engine")
        return r.returncode
    # 11/15 S2: 入れた先（stop-strata.ps1 が無い）: 会話の中継に途中の会話を残させてから，記録した server.py とその子を番号で止める
    try:
        pp = H.effective()["proxy_port"]
        if listening(pp):
            urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{pp}/proxy/save-live", data=b"", method="POST"), timeout=150).read()
    except Exception:
        pass
    if not H.alive("engine"):
        return 1          # 自分で起こした物ではない（ほかの Strata）．止めない
    H.stop_tree("engine")
    for _ in range(120):
        if not listening(port):
            return 0
        time.sleep(0.25)
    return 1


def start_engine(cfg, s, key):
    """エンジンを起こす．試しのときは環境変数 SYNC_ENGINE_CMD（{port} と {config} を差し込む命令．偽の Strata など）を代わりに起こす"""
    port = s["api_port"]
    fake = os.environ.get("SYNC_ENGINE_CMD")
    child_env = dict(os.environ)
    if key:
        child_env["STRATA_API_KEY"] = key          # 引数に書かない（プロセスの一覧に出さない）
    if fake:
        import shlex
        cmd = [x.replace("{port}", str(port)).replace("{config}", os.path.normpath(cfg)) for x in shlex.split(fake, posix=False)]
        cmd = [x[1:-1] if len(x) > 1 and x[0] == x[-1] == '"' else x for x in cmd]
        sv = H.spawn("engine", cmd, env=child_env, log=f"{ROOT}/server.out", port=port)
        return sv
    cmd = [PY, "-s", "-X", "utf8", SERVER_PY, "--engine", "strata", "--config", os.path.normpath(cfg), "--port", str(port)]
    if s["api_host"] not in ("127.0.0.1", "localhost"):
        cmd += ["--host", s["api_host"]]
    sv = subprocess.Popen(cmd, cwd=os.path.dirname(os.path.dirname(SERVER_PY)), stdout=open(f"{ROOT}/server.out", "w"), stderr=subprocess.STDOUT,
                          env=child_env, creationflags=0x00000200 | 0x08000000)
    H.remember("engine", sv.pid, port, real=True)
    return sv


def config_context(path):
    """起動の設定ファイルの --max-context（無ければ None）"""
    try:
        args = json.load(open(path, encoding="utf-8")).get("args") or []
        return int(args[args.index("--max-context") + 1])
    except (OSError, ValueError, IndexError):
        return None


START_ATTEMPTS = 4      # 11/17 F: 起動の試しの上限（最初を含む）


def start_once(cfg, log, s, key, pick):
    """エンジンを 1 回起こして /health を待つ（最大 420 秒）．学習した専門家の並びで起きなかったときは，それを退けてもう 1 回（11/16）．起きたら True"""
    H._sync_ctx.note_start(cfg, log)   # 11/15 係 C: 起こす設定と記録の大きさ（この起動の K/V の WARNING を探すため）
    t0 = time.time()
    sv = start_engine(cfg, s, key)
    while time.time() - t0 < 420 and not health():
        if sv.poll() is not None:
            break
        time.sleep(1)
    lp = learned_profile(pick["id"])
    if not health() and os.path.exists(lp) and not os.environ.get("SYNC_NO_PROFILE_RETRY"):
        # 11/16: 学習した並びでエンジンが起きなかった．その物を退けて，本家の並びでもう 1 回だけ起こす
        bad = lp + time.strftime(".bad-%m%d-%H%M%S")
        try:
            H.stop("engine")
            os.replace(lp, bad)
            say(f"  学習した専門家の並びで起きなかったので，それを退けて（{os.path.basename(bad)}）本家の並びで起こし直します")
            t0 = time.time()
            sv = start_engine(cfg, s, key)
            while time.time() - t0 < 420 and not health():
                if sv.poll() is not None:
                    break
                time.sleep(1)
        except OSError:
            pass
    return health()


def engine_report(text):
    """11/17 F: この起動のエンジンの記録から，席の数・取れた RAM の枠・警告を読む（知り合いの PC の記録の行の形）"""
    r = {"slots": None, "prefilled": None, "granted_budget_gib": None, "warnings": [], "seat_short": False,
         "conv_cache_off": False}
    # 11/18 E1: 会話の預け置きが空きの不足で off（エンジンの起動の行．--conversation-cache-mib を渡さないときの自動の大きさ）
    if re.search(r"conversation cache off: not enough free RAM", text):
        r["conv_cache_off"] = True
    # 11/17: VRAM の席が足りず起きない形（知り合いの PC の 01:17・01:21．「verify: needs the profile-filled VRAM expert tier」
    # 「needs at least N slots」）．この形は予約を上げると席がさらに減るので，やり直しでは予約を下げる（loosen の seat_short）
    if re.search(r"needs the profile-filled VRAM expert tier|needs at least \d+ slots", text):
        r["seat_short"] = True
    m = re.findall(r"expert cache auto: .*?-> (\d+) slots", text)
    if m:
        r["slots"] = int(m[-1])
    m = re.findall(r"pre-filled (\d+) of (\d+) slots", text)
    if m:
        r["prefilled"] = [int(m[-1][0]), int(m[-1][1])]
        if r["slots"] is None:
            r["slots"] = int(m[-1][1])
    m = re.findall(r"exceeds available commit .*?: ([\d.]+) GiB", text)
    if m:
        r["granted_budget_gib"] = float(m[-1])
    if re.search(r"the Windows commit limit is [\d.]+ GiB.*?Raise the page file", text):
        r["warnings"].append("コミットの上限に近づいています。ページファイルを大きくしてください。")
    if re.search(r"VRAM free with everything loaded - LOW", text):
        r["warnings"].append("GPU のメモリの空きがありません。VRAM の予約を増やすと安定します。")
    return r


def degraded_start(rep, seats_gib, vram_total_gib=0.0):
    """11/17 F: 通ったが遅い起動か．席の数が 100 個未満（VRAM 6 GiB 以上の PC．8 GB の PC は通常 1,000 個前後．知り合いの PC で 56 個・0 個が遅かった），
    または期待の席の数（VRAM の席の見積もり × 1024 ÷ 1 席の大きさ）の 25% 未満．VRAM が小さい PC は 100 個未満では判定しない"""
    n = rep.get("slots")
    if n is None:
        return False
    if float(vram_total_gib or 0) >= 6.0 and n < 100:
        return True
    expect = float(seats_gib) * 1024 / wintune.SLOT_MIB
    return expect >= 100 and n < 0.25 * expect


GPU_IDX = 0     # 11/18 係 A1: 選んだ NVIDIA の GPU の番号（main で決める．起動のやり直しの VRAM の待ちもその GPU を見る）


def vram_free_now():
    g = wintune.nvidia()
    if not g:
        return None
    return (g[GPU_IDX] if 0 <= GPU_IDX < len(g) else g[0]).get("vram_free_mib")


def wait_vram_free(target_mib, timeout=90, poll=2.0):
    """11/17 F: エンジンが死んだ直後は VRAM が戻っていないことがある．空きが target_mib（直前の調べ − 256）に戻るか，3 回続けて変わらなくなるまで待つ（最大 timeout 秒）．
    nvidia-smi が無ければ待たない．戻り値は (待った秒, 最後の空き MiB か None)"""
    t0 = time.time()
    last, same = None, 0
    while True:
        f = vram_free_now()
        if f is None:
            return time.time() - t0, None
        if target_mib and f >= target_mib:
            return time.time() - t0, f
        same = same + 1 if last is not None and abs(f - last) < 16 else 0
        last = f
        if same >= 3 or time.time() - t0 >= timeout:
            return time.time() - t0, f
        time.sleep(poll)


def loosen(step, cur, seat_short=False):
    """11/17 F: step 回目の起動に向けて cur（pick の写し）を緩める．戻り値は画面に出す内容．
    2 回目は設定を変えない（VRAM が空くのを待つだけ）．3 回目は VRAM の予約 +512（上限 2,048）．4 回目はさらに +512 と RAM の枠 ×0.8．
    seat_short（VRAM の席が足りない形．起きない・席が極端に少ない）は逆に，3 回目に予約 −512・4 回目にさらに −256（下限 256）．
    予約を上げると席が減るので（11/17 エンジン 1・3 の見立て．本人の「起動できるギリギリを攻める」に合わせた）．RAM の枠は席に効かないので触らない．
    文脈の長さ・K/V の形式は触らない"""
    out = []
    if seat_short:
        if step >= 3:
            new = max(256, int(cur["reserve"]) - (512 if step == 3 else 256))
            if new != cur["reserve"]:
                out.append(f"VRAM の予約を {cur['reserve']} MiB から {new} MiB に")
                cur["reserve"] = new
        return out
    if step >= 3:
        new = min(2048, int(cur["reserve"]) + 512)
        if new != cur["reserve"]:
            out.append(f"VRAM の予約を {cur['reserve']} MiB から {new} MiB に")
            cur["reserve"] = new
    if step >= 4:
        new = int(max(0.0, cur["budget"] * 0.8) * 4) / 4.0
        if new != cur["budget"]:
            out.append(f"メモリの枠を {cur['budget']} GiB から {new} GiB に")
            cur["budget"] = new
    return out


JSON_OUT = False


def main(argv=None):
    """sync up の本体（11/15 app1115 で INTERFACE.md の 3 に合わせた）．
    窓は --open のときだけ開く（窓を開くのはアプリの枠の仕事）．設定は settings.json → 引数の順で上書き，auto は PC を調べて決める"""
    ap = argparse.ArgumentParser(prog="sync up")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--desktop-auto", action="store_true", help=argparse.SUPPRESS)  # Native shell only
    mode.add_argument("--gui", action="store_true", help="エンジン＋dsh（既定．窓は開かない）")
    mode.add_argument("--no-gui", action="store_true", help="エンジン＋dsh（--gui と同じ．スマホから使う人向けの名前）")
    mode.add_argument("--api-only", action="store_true", help="エンジンだけ（dsh も会話の画面も起こさない）")
    ap.add_argument("--open", action="store_true", help="起こした後に会話の画面を Edge の窓で開く（端末から直接使う人向け）")
    ap.add_argument("--json", action="store_true", help="終わりに結果を 1 行の JSON で（途中の表示は標準エラーへ）")
    ap.add_argument("--preset", default=None, choices=("speed", "quality", "auto"), help="quality＝--tail-skip 7，speed＝--tail-skip 4 の別名")
    ap.add_argument("--tail-skip", default=None, help="起動時の tail skip 4・7・10（10＝省かない）か auto（PC のスペックで推奨の方）")
    ap.add_argument("--model", "--pack", dest="model", default=None, help="auto か一覧のモデルの id")
    ap.add_argument("--ram-max-gib", default=None)
    ap.add_argument("--vram-reserve-mib", default=None)
    ap.add_argument("--ram-squeeze", default=None, choices=("auto", "off"), help="起動・切り替えのときにほかのアプリの RAM を追い出すか（11/16 係 S4．auto＝追い出す）")
    ap.add_argument("--context", default=None)
    ap.add_argument("--kv", "--kv-format", dest="kv_format", default=None, help="会話の記憶（K/V）の量子化 k8v4・k8・k4 か auto（11/15 係 C）")
    ap.add_argument("--port", default=None, help="エンジン（API）の番号（設定 api_port）")
    ap.add_argument("--host", default=None, help="待ち受ける番地．127.0.0.1 以外には --api-key か環境変数 STRATA_API_KEY が要る")
    ap.add_argument("--api-key", default="", help="API の鍵（環境変数 STRATA_API_KEY で渡すのを勧める）")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--engine", default=ENGINE)
    ap.add_argument("--env", action="append", default=[])
    ap.add_argument("--stop", action="store_true", help="（前からの名前）エンジンを止める．sync down --engine と同じ")
    a = ap.parse_args(argv)
    global PORT, JSON_OUT
    JSON_OUT = a.json
    try:
        s = H.effective({"preset": a.preset, "tail_skip": a.tail_skip, "model": a.model, "ram_max_gib": a.ram_max_gib, "vram_reserve_mib": a.vram_reserve_mib,
                         "context": a.context, "api_port": a.port, "api_host": a.host, "ram_squeeze": a.ram_squeeze})
        H._sync_ctx.cli_kv(s, a.kv_format, H)   # 11/15 係 C: --kv
    except (ValueError, KeyError) as e:
        say(f"設定が正しくありません: {e}")
        return 2
    want = "auto" if s["model"] in (None, "auto") else s["model"]
    gui = not a.api_only
    key = a.api_key or os.environ.get("STRATA_API_KEY", "")
    result = {"ok": False, "mode": "api-only" if a.api_only else "gui", "settings": s}

    def done(code, **more):
        result.update(more, ok=code == 0, code=code)
        if JSON_OUT:
            print(json.dumps(result, ensure_ascii=False), flush=True)
        return code

    if a.desktop_auto and s["desktop_auto_start"] == "off" and not (a.dry or a.stop):
        # Keep chat and explicit model starts available without loading the engine.
        # start_dsh reuses running services and handles port selection itself.
        ok = H.start_dsh(s, say)
        if ok and a.open:
            say("  " + open_gui(url=H.gui_url(s)))
        return done(0 if ok else 6, engine_started=False,
                    url=f"http://127.0.0.1:{s['relay_port']}/m/" if ok else None,
                    **({} if ok else {"error": H.DSH_ERROR or "dsh か会話の画面の中継が起きませんでした"}))

    if not a.stop:       # 11/18 W12: ふさがっている番号は空いている番号に替える（--stop は書かれている番号のまま止める．--dry は書かない）
        H.ensure_ports(s, say, persist=not a.dry)
    PORT = s["api_port"]

    import sync_env      # 11/15 夜: 対応外の PC では起こさずに理由を返す（終了コード 8．アプリの枠の「起動の失敗」に出る）
    ev = sync_env.check()
    if not ev["ok"]:
        for it in ev["blockers"]:
            say("この PC では使えません: " + sync_env.text(it, sync_i18n.lang()))
        envj = {k: ev[k] for k in ("ok", "blockers", "warnings")}
        if gui and not a.no_gui and not a.dry:
            # 11/15 夜: --gui は dsh と中継だけ起こし，会話の画面（/m/env）で理由を見せる（エンジンは起こさない．初回のモデルなしと同じ扱い）
            ok = H.start_dsh(s, say)
            url = f"http://127.0.0.1:{s['relay_port']}/m/"
            if ok and a.open:
                say("  " + open_gui(url=H.gui_url(s)))
            return done(0 if ok else 6, unsupported=True, engine=None, engine_started=False, env=envj, url=url,
                        **({} if ok else {"error": H.DSH_ERROR or "dsh か会話の画面の中継が起きませんでした"}))
        return done(sync_env.EXIT_UNSUPPORTED, error="unsupported", env=envj)
    for it in ev["warnings"]:
        say("  ！" + sync_env.text(it, sync_i18n.lang()))
    if s["api_host"] not in ("127.0.0.1", "localhost", "::1") and not key:
        say("127.0.0.1 以外で待ち受けるには鍵が要ります（--api-key か 環境変数 STRATA_API_KEY）．")
        return done(2)
    os.makedirs(ROOT, exist_ok=True)
    if a.stop:
        return done(stop_engine(PORT))
    if health() and not a.dry:
        say("Strata はもう動いています．")
        for line in api_info(s["api_host"], PORT, bool(key)):
            say(line)
        if gui:
            write_head_name(None)      # 11/18 W11: 動いているモデルは choice.json（前の起動が残した）から
            if not H.start_dsh(s, say):
                return done(6, error=H.DSH_ERROR or "dsh か会話の画面の中継が起きませんでした")
            if a.open:
                say("  " + open_gui(url=H.gui_url(s)))
        return done(0, engine="already-up", url=f"http://127.0.0.1:{s['relay_port']}/m/" if gui else None)
    # 11/15 app1115: はじめて（モデルか共通の部品が無い）: GUI なら dsh と会話の画面だけ起こす（画面がダウンロードの案内を出す）
    ms = H.models_state()
    if not ms["installed"] or ms["missing_shared"]:
        say(f"まだ入っていない物があります（モデル: {', '.join(ms['installed']) or 'なし'}，足りない共通の部品: {', '.join(ms['missing_shared']) or 'なし'}）．")
        if gui and not a.dry:
            ok = H.start_dsh(s, say)
            url = f"http://127.0.0.1:{s['relay_port']}/m/"
            if ok and a.open:
                say("  " + open_gui(url=H.gui_url(s)))
            say(f"  会話の画面（{url}）でダウンロードしてから，起動してください．" if ok else "  dsh が起きませんでした．")
            return done(0 if ok else 6, first_run=True, engine=None, missing=ms, url=url,
                        **({} if ok else {"error": H.DSH_ERROR or "dsh か会話の画面の中継が起きませんでした"}))
        return done(4, first_run=True, error="モデルか共通の部品がまだありません（sync up --gui で画面を開いてダウンロード）", missing=ms)
    sq = apply_squeeze(s, a.dry)       # 11/16 係 S4: 追い出した後の空き RAM で，下の PC の調べ（RAM の枠）が決まる
    result["squeeze"] = {k: sq.get(k) for k in ("ran", "before_gib", "after_gib", "freed_gib", "seconds", "detail")}
    say("1/5 PC を調べています（10 秒ほど）...")
    pre = wintune.preflight(PACKS[0]["dir"] if PACKS else None, do_ssd=False)
    if "error" in pre:
        say("調べられませんでした: " + pre["error"])
        return done(3, error=pre["error"])
    # 11/18: NVIDIA の GPU が複数のとき，sync_env が選んだ GPU（対応するキットがあり世代が新しく VRAM の大きい物）を先頭にする．
    # 自動設定（choose・起動のやり直しの VRAM の待ち）は先頭の GPU を見るので，選んだ GPU の VRAM で決まる．エンジンもその番号で起こす（make_config）
    _gi = ev["gpu"].get("index") if ev["gpu"].get("vendor") == "nvidia" else None
    if _gi is not None and len(pre.get("gpus") or []) > 1 and 0 <= int(_gi) < len(pre["gpus"]):
        pre["gpus"] = [pre["gpus"][int(_gi)]] + [g for i, g in enumerate(pre["gpus"]) if i != int(_gi)]
        global GPU_IDX
        GPU_IDX = int(_gi)
        say(f"  ・GPU が {len(pre['gpus'])} 枚あります。{pre['gpus'][0].get('name')}（{_gi} 番）を使います。")
    if ev["gpu"].get("vendor") == "amd" and pre.get("gpus"):
        pre["gpus"] = []      # 11/18 W8: NVIDIA が全部対応外で Radeon を選んだとき，nvidia-smi の GPU（対応外）の値で決めない．下で Radeon の見込みの値を入れる
    if not pre.get("gpus") and ev["gpu"].get("vendor") == "amd":
        # 11/15 夜: Radeon には nvidia-smi が無い．VRAM は表示アダプターの欄の大きさから，空きは 1.5 GiB 引いた見込み（不明なら 0＝全部 RAM に），
        # 画面はこの GPU につないでいる（予約を多めに）と見て，控えめな側に決める
        vg = ev["gpu"].get("vram_gib")
        # 11/20 0.1.3: VRAM の総量も渡す（前は渡さず，予約の決め方が 16 GiB の Radeon でも「10 GiB 未満」の 512 MiB になっていた．
        # GitHub Issue #2 の RX 6900 XT は 512 MiB の予約で，全部読んだ後の VRAM の空きが 320 MiB だった）
        pre["gpus"] = [{"name": ev["gpu"].get("name"), "display_active": "Enabled", "vram_free_mib": max(0, (float(vg) - 1.5) * 1024) if vg else 0,
                        "vram_total_mib": float(vg) * 1024 if vg else 0, "assumed": True}]
        say(f"  ・Radeon（{ev['gpu'].get('name')}）: VRAM {vg if vg else '不明'} GiB として控えめに決めます")
    pick, why = choose(pre, s["preset"] or "quality", want, s["ram_max_gib"], s["vram_reserve_mib"])
    # 11/15: 起動時の tail skip: 設定・引数の tail_skip → preset（7・4 の別名）→ PC のスペックで推奨（R4 か R7）
    sp = None
    if s["tail_skip"]:
        R, rwhy = int(s["tail_skip"]), "指定どおり"
    elif s["preset"]:
        R, rwhy = R_OF[s["preset"]], f"preset {s['preset']} の別名"
    else:
        sp = H.spec()
        R, rwhy = sp["recommended_r"], sp["reason"]
    if pick:
        pick["R"] = R
    why.append(f"起動時の tail skip は R{R}{'（省かない）' if R == 10 else ''}（{rwhy}）．API を別のソフトから使うときだけ効く（dsh の会話は会話ごとのモデルに従う）")
    if sq.get("why"):
        why.insert(1, sq["why"])
    elif sq.get("detail") and s.get("ram_squeeze") == "off":
        why.insert(1, "ほかのアプリの RAM は追い出していません（設定 ram_squeeze が off）")
    for w in why:
        say("  ・" + w)
    notes = [x for x in pre.get("advice", []) if not x.startswith("Sync-M は") and not x.startswith("ただし")]
    for x in notes:
        say("  ！" + x)
    rec = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "preset": s["preset"], "pick": pick, "why": why, "advice": notes,
           "ram": pre.get("ram"), "gpu": (pre.get("gpus") or [{}])[0], "settings": s}
    if pick is None:
        json.dump(rec, open(f"{ROOT}/last.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        return done(4, error="手元にモデルがありません", why=why, first_run=True)
    pick["kv_format"] = s.get("kv_format")   # 11/15 係 C
    prev_ctx = config_context(f"{ROOT}/cfg/auto.json")      # 11/17 G: 前の起動の文脈の長さ（変わったら画面に出す）
    cfg, log = make_config(pick, a.engine, a.env, s["context"])
    new_ctx = config_context(cfg)
    if prev_ctx and new_ctx and prev_ctx != new_ctx:
        why.append(f"文脈の長さが前回の {prev_ctx} から {new_ctx} に変わっています。")
        say(f"  ・文脈の長さが前回の {prev_ctx} から {new_ctx} に変わっています。")
    rec.update(config=cfg, download_if_missing=download_plan(pick))
    json.dump(rec, open(f"{ROOT}/last.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    picked = {"model": pick["id"], "r": pick["R"], "ram_budget_gib": pick["budget"], "vram_reserve_mib": pick["reserve"], "why": why}
    if a.dry:
        say(f"（--dry: 起動しません．設定は {cfg}）")
        if gui:
            say(f"  dsh {'動いている' if listening(s['dsh_port']) else '止まっている'}，会話の画面の中継（{s['relay_port']}）"
                f"{'動いている' if listening(s['relay_port']) else '止まっている'}．--open なら: {open_gui(dry=True, url=H.gui_url(s))}")
        return done(0, dry=True, pick=picked, config=cfg)
    save_choice(pick, s["relay_port"])
    say("2/5 dsh は起こしません（--api-only）" if not gui else "2/5 dsh を起こしています...")
    if gui:
        write_head_name(pick["name"])      # 11/18 W11: 中継が dsh の頭の「strata-rN」をこの名前に替える（R4・R7 で頭を共有）
        ok = H.start_dsh(s, say)
        say("  dsh: " +("動いています" if ok else "起きませんでした"))
        if not ok:      # 11/16: dsh が起きない（番号を別のプログラムが使っているなど）ならエンジンは起こさずに理由を返す
            return done(6, error=H.DSH_ERROR or "dsh か会話の画面の中継が起きませんでした", pick=picked)
    say(f"3/5 {pick['name']} を読み込んでいます（30 秒〜2 分）...")
    fake = bool(os.environ.get("SYNC_ENGINE_CMD"))
    # 11/17 F: 起動に失敗した（または席が極端に少ない遅い起動になった）ら，VRAM が空くのを待ち，設定を少しずつ緩めてやり直す（上限 START_ATTEMPTS 回）．
    # 緩めるのは VRAM の予約と RAM の枠だけ．文脈の長さ・K/V の形式は緩めない（本人の決まり）．モデルは替えない（使う人に聞いてから）
    cur = dict(pick)
    tries = []
    for attempt in range(1, START_ATTEMPTS + 1):
        t0 = time.time()
        log0 = os.path.getsize(log) if os.path.exists(log) else 0   # 11/17 I-12: 記録は追記．この起動の分だけ読む（前の起動の行を拾って 3 モデルで同じ数字が出ていた）
        up = start_once(cfg, log, s, key, pick)
        text = open(log, "rb").read()[log0 if os.path.getsize(log) >= log0 else 0:].decode("utf-8", "replace") if os.path.exists(log) else ""
        rep = engine_report(text)
        slow = up and not fake and degraded_start(rep, cur.get("seats_gib") or 0, float((pre.get("gpus") or [{}])[0].get("vram_total_mib") or 0) / 1024)
        if up:
            for w in rep.get("warnings", []):
                say("  ・エンジンの警告: " + w)
            if rep.get("granted_budget_gib") is not None and rep["granted_budget_gib"] + 0.25 < cur["budget"]:
                say(f"  ・メモリの枠は {cur['budget']} GiB を頼みましたが、エンジンは {rep['granted_budget_gib']} GiB しか取れませんでした。")
        # 11/18 E1（本人の決定）: エンジンがコミットで枠を削った PC は，コミットで削られた PC として 1 回だけ起こし直す（commit_restart）
        _cr = commit_restart(cur, rep) if (up and not fake and attempt < START_ATTEMPTS) else None
        if _cr is not None:
            cur.update(_cr)
            cur["commit_restarted"] = True
            say("  ・Windows のメモリの上限（コミット）が足りないため、会話を預ける場所を空けて、もう一度起動します。")
            stop_engine(PORT)
            waited, vfree = wait_vram_free(((pre.get("gpus") or [{}])[0].get("vram_free_mib") or 0) - 256)
            tries.append({"attempt": attempt, "reason": "commit", "granted_budget_gib": rep.get("granted_budget_gib"),
                          "vram_wait_s": round(waited, 1), "vram_free_mib": vfree,
                          "changes": [f"RAM の枠 {cur['budget']} GiB", "ファイルの側をファイルのキャッシュ経由で読む",
                                      f"会話を預ける場所の分 {cur['conv_cache_extra_gib']} GiB"]})
            cfg, log = make_config(cur, a.engine, a.env, s["context"])
            picked.update(ram_budget_gib=cur["budget"], vram_reserve_mib=cur["reserve"])
            rec.update(config=cfg, retries=tries)
            json.dump(rec, open(f"{ROOT}/last.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            continue
        if up and not fake and rep.get("conv_cache_off"):    # 11/18 E1: エンジンの記録で預け置きが off（起こし直しでは変わらない PC）
            say("  ・会話を預ける場所が取れないため、別の会話から戻ると、最初から読み直します。")
        if up and not slow:
            break
        if attempt == START_ATTEMPTS:
            if slow:        # 最後の回: 遅いが動いているので，止めずにそのまま使う
                say(f"  席が {rep.get('slots')} 個です。このまま使いますが、遅くなります。")
            break
        why_fail = "遅い起動（GPU の席 %s 個）" % rep.get("slots") if slow else "起動に失敗"
        say(f"  {why_fail}（{attempt}/{START_ATTEMPTS}）。" + ("もう一度やり直します。" if slow else "GPU のメモリが空くのを待ちます。"))
        stop_engine(PORT)
        waited, vfree = wait_vram_free(((pre.get("gpus") or [{}])[0].get("vram_free_mib") or 0) - 256)
        say(f"  GPU のメモリの空きは {vfree} MiB です（{waited:.0f} 秒待ちました）。" if vfree is not None else "  GPU のメモリの空きは調べられませんでした。")
        seat_short = slow or bool(rep.get("seat_short"))     # 11/17: 席が足りない形は予約を下げる向きに緩める
        if seat_short and not slow:
            why_fail = "GPU のメモリが足りず、専門家の席を作れませんでした"
        changes = loosen(attempt + 1, cur, seat_short)
        say("  設定を少し緩めて、もう一度起動します。" + ("、".join(changes) + "。" if changes else "設定は同じです。"))
        tries.append({"attempt": attempt, "reason": why_fail, "slots": rep.get("slots"), "seat_short": seat_short, "vram_wait_s": round(waited, 1), "vram_free_mib": vfree, "changes": changes})
        cfg, log = make_config(cur, a.engine, a.env, s["context"])
        picked.update(ram_budget_gib=cur["budget"], vram_reserve_mib=cur["reserve"])
        rec.update(config=cfg, retries=tries)
        json.dump(rec, open(f"{ROOT}/last.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if tries:
        result["retries"] = tries
        rec["retries"] = tries
    if not health():
        say("  起動できませんでした．記録: " + log)
        if tries:
            say(f"  {START_ATTEMPTS} 回やっても起動できませんでした。試した内容: " + " ／ ".join(f"{t['attempt'] + 1} 回目 " + ("、".join(t["changes"]) or "同じ設定") for t in tries) + "。")
        json.dump(rec, open(f"{ROOT}/last.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        smaller = [c for c in PACKS if c["experts_gib"] < pick["experts_gib"] and os.path.exists(os.path.join(c["dir"], "experts.v2.bin"))]
        return done(5, error="エンジンが起きませんでした", log=log, pick=picked, suggest_model=smaller[0]["id"] if smaller else None)   # 軽いモデルは聞いてから（替えない）
    text = open(log, "rb").read()[log0 if os.path.getsize(log) >= log0 else 0:].decode("utf-8", "replace") if os.path.exists(log) else ""
    ms_ = re.findall(r"resident ([\d.]+) GiB, pinned ([\d.]+) GiB", text)
    m = ms_[-1] if ms_ else None      # 11/17 I-12: この起動の最後の行
    say(f"  読み込み {time.time() - t0:.0f} 秒" + (f"，RAM の写し {m[0]} GiB（GPU から読める固定 {m[1]} GiB）" if m else ""))
    if not fake:
        say("4/5 落ち着くのを待って，温めています...")
        ts = time.time()
        pr = av = None
        while time.time() - ts < 120:
            pr, av = page_reads()
            if pr is not None and pr < 300:
                break
        start = os.path.getsize(log)
        warm(pick["R"], key)
        warm(pick["R"], key)
        d = wintune.diagnose(log, start)
        say("  " + (d.get("findings") or [d.get("error", "")])[0])
        wh = warm_head(s, key) if gui else (False, "api-only")     # 11/18 W11: dsh の頭での温め（裏．上の 2 回は落ち着くのを待つ役目のまま）
        if wh[0]:
            say("  最初の会話に備えて，dsh の指示文を裏で読み込んでいます．")
        rec.update(after={"page_reads_s": pr, "avail_mib": av, "diagnose": d, "warm_head": wh[1]})
        json.dump(rec, open(f"{ROOT}/last.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for line in api_info(s["api_host"], PORT, bool(key)):
        say(line)
    if not gui:
        say("5/5 API だけ起こしました．止めるのは: sync down --engine")
        return done(0, pick=picked)
    url = f"http://127.0.0.1:{s['relay_port']}/m/"
    if not listening(s["relay_port"]):
        say(f"  会話の画面の中継（{s['relay_port']}）が動いていません．")
        return done(6, error="会話の画面の中継が動いていません", pick=picked)
    if a.open:
        say("5/5 " + open_gui(url=H.gui_url(s)))
    else:
        say(f"5/5 起きました．会話の画面: {url}（窓は開いていません．開くのは --open か sync gui-url の URL）")
    if pre["ram"]["total_gib"] <= 33:
        say("  ヒント: この PC は RAM が 32 GB 以下です．会話の画面はスマホ・タブレットから開くほうが速くなります（PC のブラウザーが RAM と GPU を使うため）．")
    return done(0, pick=picked, url=url)


if __name__ == "__main__":
    sys.exit(main())
