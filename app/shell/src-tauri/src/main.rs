// Sync-Strata のアプリの枠（11/15 係 T）．
// 本家 Strata の apps/desktop（Tauri 2）から，窓・1 つだけ起動・常駐・インストーラーの部分だけを残して書き直した物．
// 起動・停止はすべて起動の道具（sync.py．INTERFACE.md の 3）に任せ，ここはそれを呼んで結果を見せるだけ．
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod i18n;
mod prio;

use i18n::{t, tf, Lang};
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Tauri（wry）が Windows で既定に付ける引数．追加の引数を渡すと既定が消えるので，自分で付け直す．
const WEBVIEW2_BASE_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

// ------------------------------------------------------------------ 設定

/// 枠の設定．優先は 環境変数 → exe と同じフォルダーの shell.json → 同梱の物 → 既定．
struct Cfg {
    python: String,
    python_args: Vec<String>,
    launcher: PathBuf,
    home: PathBuf,
    /// 起動の道具へ渡す追加の環境変数（試しのポートなど）．
    env: Vec<(String, String)>,
    /// auto｜on｜off（WebView2 に GPU を使わせるか）．
    gpu: String,
    /// どこから gpu を決めたか（arg｜env｜settings｜default．状態の窓が文に替える）．
    gpu_from: String,
    /// 画面の子プロセスの優先度（low｜idle｜normal）．
    prio: prio::Prio,
    prio_from: String,
    /// 試しだけ: WebView2 の DevTools のポート（画面を外から確かめる）．
    devtools_port: Option<u16>,
    log: PathBuf,
}

fn exe_dir() -> PathBuf {
    // Linux の AppImage は中身を一時の置き場に広げて動くので，AppImage のファイル自身の置き場を「自分の位置」にする．
    #[cfg(target_os = "linux")]
    if let Some(p) = env_nonempty("APPIMAGE").map(PathBuf::from) {
        if let Some(d) = p.parent() {
            return d.to_path_buf();
        }
    }
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("."))
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Linux のデータの置き場（$XDG_DATA_HOME，無ければ ~/.local/share）．
#[cfg(not(windows))]
fn linux_data_home() -> PathBuf {
    env_nonempty("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env_nonempty("HOME").unwrap_or_else(|| ".".into())).join(".local").join("share"))
}

/// Linux: トレイの部品（appindicator）が読み込めるか．読み込めないままトレイを作ると panic で落ちるので，先に確かめる．
#[cfg(target_os = "linux")]
fn appindicator_available() -> bool {
    for name in ["libayatana-appindicator3.so.1", "libappindicator3.so.1"] {
        let c = std::ffi::CString::new(name).unwrap();
        let h = unsafe { libc::dlopen(c.as_ptr(), libc::RTLD_LAZY) };
        if !h.is_null() {
            unsafe { libc::dlclose(h) };
            return true;
        }
    }
    false
}

/// Linux（WebKitGTK）の描画の切り替え．GTK が起きる前（main の最初）に環境変数で決める．
/// auto: 本家と同じく DMA-BUF の描き方だけ切る（NVIDIA＋Wayland で窓が白くなるのを避ける）．
/// off: 合成も GL も CPU で（WEBKIT_DISABLE_COMPOSITING_MODE と LIBGL_ALWAYS_SOFTWARE）．on: 合成を GPU で強いる．
/// 本人が自分で変数を決めていれば，それを残す．
#[cfg(target_os = "linux")]
fn apply_linux_render_env(gpu: &str) {
    let set = |k: &str, v: &str| {
        if std::env::var_os(k).is_none() {
            std::env::set_var(k, v);
        }
    };
    set("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    match gpu {
        "off" => {
            set("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            set("LIBGL_ALWAYS_SOFTWARE", "1");
        }
        "on" => set("WEBKIT_FORCE_COMPOSITING_MODE", "1"),
        // WSL の中（WSLg）は GL の合成が使えず窓が白くなるので，auto でも CPU で描く（11/16 に WSLg で確かめた）．
        _ if env_nonempty("WSL_DISTRO_NAME").is_some() => {
            set("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            set("LIBGL_ALWAYS_SOFTWARE", "1");
        }
        _ => {}
    }
}

/// `--gpu=off` か `--gpu off` の形の引数を読む．
fn cli_value(args: &[String], name: &str) -> Option<String> {
    let flag = format!("--{name}");
    let eq = format!("--{name}=");
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if let Some(v) = a.strip_prefix(&eq) {
            return Some(v.to_string());
        }
        if a == &flag {
            return it.next().cloned();
        }
    }
    None
}

fn load_cfg(args: &[String]) -> Cfg {
    let dir = exe_dir();
    let file: Value = std::fs::read_to_string(dir.join("shell.json"))
        .ok()
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or(Value::Null);
    let fstr = |k: &str| file.get(k).and_then(Value::as_str).map(str::to_string).filter(|v| !v.is_empty());

    // Python: SYNC_PYTHON → shell.json の python → 配布の並び（app\python\python.exe．exe は app\shell\ にある）
    //         → exe と同じフォルダーの python\python.exe → PATH の python．
    let app_dir = dir.parent().map(Path::to_path_buf).unwrap_or_else(|| dir.clone());
    #[cfg(windows)]
    let (py_rel, py_fallback) = (["python", "python.exe"], "python");
    #[cfg(not(windows))]
    let (py_rel, py_fallback) = (["python", "bin/python3"], "python3");
    #[allow(unused_mut)]
    let mut py_candidates = vec![app_dir.join(py_rel[0]).join(py_rel[1]), dir.join(py_rel[0]).join(py_rel[1])];
    // Linux: deb で /usr/bin に入ったときは，決まった入れた先（データの置き場の SyncStratapp）も探す．
    #[cfg(target_os = "linux")]
    py_candidates.push(linux_data_home().join("SyncStrata").join("app").join(py_rel[0]).join(py_rel[1]));
    let python = env_nonempty("SYNC_PYTHON").or_else(|| fstr("python")).unwrap_or_else(|| {
        py_candidates.iter().find(|p| p.exists()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| py_fallback.to_string())
    });
    let mut python_args: Vec<String> = file
        .get("python_args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    // py ランチャーなら -3 を付ける（付け忘れの救済）．
    if python_args.is_empty() && Path::new(&python).file_stem().map(|s| s.eq_ignore_ascii_case("py")).unwrap_or(false) {
        python_args.push("-3".into());
    }

    // 起動の道具: SYNC_LAUNCHER → shell.json の launcher → 配布の並び（app\launcher\sync.py）→ exe と同じフォルダーの launcher\sync.py．
    // 開発用の固定の置き場は持たない（開発では環境変数か shell.json で指す）．見つからなければ配布の並びの道のりで失敗を出す．
    #[allow(unused_mut)]
    let mut launcher_candidates = vec![app_dir.join("launcher").join("sync.py"), dir.join("launcher").join("sync.py")];
    #[cfg(target_os = "linux")]
    launcher_candidates.push(linux_data_home().join("SyncStrata").join("app").join("launcher").join("sync.py"));
    let launcher = env_nonempty("SYNC_LAUNCHER").or_else(|| fstr("launcher")).map(PathBuf::from).unwrap_or_else(|| {
        launcher_candidates.iter().find(|p| p.exists()).cloned().unwrap_or_else(|| launcher_candidates[0].clone())
    });

    // 設定の置き場: SYNC_HOME → shell.json の home → %LOCALAPPDATA%\SyncStrata（INTERFACE.md の 4）．
    // Linux の既定は $XDG_CONFIG_HOME（無ければ ~/.config）の SyncStrata（INTERFACE.md の 8）．
    let home = env_nonempty("SYNC_HOME").or_else(|| fstr("home")).map(PathBuf::from).unwrap_or_else(|| {
        #[cfg(windows)]
        let base = PathBuf::from(env_nonempty("LOCALAPPDATA").unwrap_or_else(|| ".".into()));
        #[cfg(not(windows))]
        let base = env_nonempty("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env_nonempty("HOME").unwrap_or_else(|| ".".into())).join(".config"));
        base.join("SyncStrata")
    });
    let _ = std::fs::create_dir_all(&home);

    let env: Vec<(String, String)> = file
        .get("env")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();

    // GPU: 引数 --gpu → 環境変数 SYNC_GUI_GPU → settings.json の gui_gpu → auto．
    let settings_gpu = std::fs::read_to_string(home.join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.get("gui_gpu").and_then(Value::as_str).map(str::to_string));
    let (gpu_raw, gpu_from) = if let Some(v) = cli_value(args, "gpu") {
        (v, "arg")
    } else if let Some(v) = env_nonempty("SYNC_GUI_GPU") {
        (v, "env")
    } else if let Some(v) = settings_gpu {
        (v, "settings")
    } else {
        ("auto".to_string(), "default")
    };
    let gpu = match gpu_raw.trim().to_ascii_lowercase().as_str() {
        "on" | "gpu" => "on",
        "off" | "cpu" => "off",
        _ => "auto",
    }
    .to_string();

    // 画面の優先度: 引数 --gui-priority → 環境変数 SYNC_GUI_PRIORITY → settings.json の gui_priority → cpu-low（11/16 係 T3．low は GPU の優先度も下げるが，測りで効きが見えず，Strata との取り合いで画面のコマが遅れるおそれだけ残るため）．
    let settings_prio = std::fs::read_to_string(home.join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.get("gui_priority").and_then(Value::as_str).map(str::to_string));
    let (prio_raw, prio_from) = if let Some(v) = cli_value(args, "gui-priority") {
        (v, "引数 --gui-priority")
    } else if let Some(v) = env_nonempty("SYNC_GUI_PRIORITY") {
        (v, "環境変数 SYNC_GUI_PRIORITY")
    } else if let Some(v) = settings_prio {
        (v, "settings.json の gui_priority")
    } else {
        ("cpu-low".to_string(), "既定")
    };
    let prio = prio::Prio::parse(&prio_raw);

    let devtools_port = cli_value(args, "devtools-port").or_else(|| env_nonempty("SYNC_SHELL_DEVTOOLS_PORT")).and_then(|v| v.parse().ok());
    let log = home.join("shell.log");
    Cfg { python, python_args, launcher, home, env, gpu, gpu_from: gpu_from.to_string(), prio, prio_from: prio_from.to_string(), devtools_port, log }
}

impl Cfg {
    /// WebView2 の追加の引数．すべての窓で同じにする（同じ WebView2 の環境を共有するため）．
    fn browser_args(&self) -> String {
        let mut a = WEBVIEW2_BASE_ARGS.to_string();
        match self.gpu.as_str() {
            "off" => a.push_str(" --disable-gpu"),
            "on" => a.push_str(" --ignore-gpu-blocklist"),
            _ => {}
        }
        if let Some(p) = self.devtools_port {
            a.push_str(&format!(" --remote-debugging-port={p}"));
        }
        a
    }

    fn log(&self, line: &str) {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.log) {
            let _ = writeln!(f, "{t} pid={} {line}", std::process::id());
        }
    }
}

// ------------------------------------------------------------------ 起動の道具を呼ぶ

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

fn launcher_cmd(cfg: &Cfg, args: &[&str]) -> Command {
    let mut c = Command::new(&cfg.python);
    c.args(&cfg.python_args).arg("-X").arg("utf8").arg(&cfg.launcher).args(args);
    c.env("SYNC_HOME", &cfg.home).env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    for (k, v) in &cfg.env {
        c.env(k, v);
    }
    // 英語・中国語の画面では起動の道具の文を英語に（起動の道具に中国語は無い）．日本語のときは渡さない．
    if i18n::cur() != Lang::Ja {
        c.env("SYNC_LANG", "en");
    }
    if let Some(dir) = cfg.launcher.parent() {
        c.current_dir(dir);
    }
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    #[cfg(target_os = "linux")]
    strip_appimage_env(&mut c);
    c
}

/// Linux の AppImage は中の GTK・Python のための変数（PYTHONHOME・LD_LIBRARY_PATH など）を足す．
/// それが起動の道具（PC の Python や同梱の Python）に漏れると Python が起きないので，子には渡さない．
#[cfg(target_os = "linux")]
fn strip_appimage_env(c: &mut Command) {
    let Some(appdir) = env_nonempty("APPDIR") else { return };
    for k in [
        "PYTHONHOME", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "LD_LIBRARY_PATH", "PERLLIB", "QT_PLUGIN_PATH",
        "GDK_PIXBUF_MODULE_FILE", "GIO_MODULE_DIR", "GI_TYPELIB_PATH", "GSETTINGS_SCHEMA_DIR", "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_SYSTEM_PATH_1_0", "GTK_DATA_PREFIX", "GTK_EXE_PREFIX", "GTK_IM_MODULE_FILE", "GTK_PATH", "GTK_THEME",
        "APPDIR", "ARGV0", "OWD",
    ] {
        c.env_remove(k);
    }
    // PATH と XDG_DATA_DIRS からは AppImage の中の道のりだけを外す．
    for k in ["PATH", "XDG_DATA_DIRS"] {
        if let Some(v) = std::env::var_os(k) {
            let kept: Vec<PathBuf> = std::env::split_paths(&v).filter(|p| !p.starts_with(&appdir)).collect();
            match std::env::join_paths(kept) {
                Ok(j) if !j.is_empty() => {
                    c.env(k, j);
                }
                _ => {
                    c.env_remove(k);
                }
            }
        }
    }
}

/// 起動の道具を呼んで，終わるまで待つ．`secret` のときは出力を記録しない（gui-url のトークン）．
fn run_launcher(cfg: &Cfg, args: &[&str], secret: bool) -> Result<Out, String> {
    let started = Instant::now();
    let out = launcher_cmd(cfg, args).stdin(Stdio::null()).output().map_err(|e| {
        let msg = tf("err.call", &[&cfg.python, &e.to_string()]);
        cfg.log(&format!("call {} → 失敗 {msg}", args.join(" ")));
        msg
    })?;
    let code = out.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if secret {
        cfg.log(&format!("call {} → {code}（{} ms，出力は記録しない）", args.join(" "), started.elapsed().as_millis()));
    } else {
        cfg.log(&format!("call {} → {code}（{} ms）{}", args.join(" "), started.elapsed().as_millis(), last_line(&stderr)));
    }
    Ok(Out { code, stdout, stderr })
}

fn last_line(s: &str) -> String {
    s.lines().rev().find(|l| !l.trim().is_empty()).map(|l| redact(l.trim())).unwrap_or_default()
}

/// トークンらしき物を含む行は見せない（INTERFACE.md の 6）．
fn redact(line: &str) -> String {
    let low = line.to_ascii_lowercase();
    if low.contains("token") || low.contains("?t=") || low.contains("&t=") || low.contains("api_key") || low.contains("bearer") {
        t("prog.redacted")
    } else {
        line.to_string()
    }
}

fn status_json(cfg: &Cfg) -> Result<Value, String> {
    let o = run_launcher(cfg, &["status", "--json"], false)?;
    serde_json::from_str::<Value>(o.stdout.trim()).map_err(|_| {
        let why = if o.stderr.trim().is_empty() { last_line(&o.stdout) } else { last_line(&o.stderr) };
        tf("err.status", &[&o.code.to_string(), &why])
    })
}

/// 画面の言語を決める: 環境変数 SYNC_LANG → 起動の道具の設定 ui_lang（settings get --json．auto・無い・知らない値は次へ）
/// → OS の言語 → 英語．返すのは（言語，どこで決めたか）．
fn resolve_lang(cfg: &Cfg) -> (Lang, &'static str) {
    if let Some(l) = env_nonempty("SYNC_LANG").and_then(|v| Lang::parse(&v)) {
        return (l, "SYNC_LANG");
    }
    if cfg.launcher.exists() {
        if let Ok(o) = run_launcher(cfg, &["settings", "get", "--json"], false) {
            let ui = serde_json::from_str::<Value>(o.stdout.trim())
                .ok()
                .and_then(|v| v.pointer("/settings/ui_lang").and_then(Value::as_str).map(str::to_string));
            if let Some(l) = ui.as_deref().and_then(Lang::parse) {
                return (l, "ui_lang");
            }
        }
    }
    match i18n::os_lang() {
        Some(l) => (l, "OS"),
        None => (Lang::En, "fallback"),
    }
}

/// 言語を決め直して今の言語にする（起動時と，閉じる小窓・状態の窓を作るとき）．
fn refresh_lang(cfg: &Cfg) {
    let (l, from) = resolve_lang(cfg);
    if l != i18n::cur() {
        cfg.log(&format!("画面の言語 {}（{from}）", l.code()));
    }
    i18n::set(l);
}

fn is_up(v: &Value, part: &str) -> bool {
    v.get(part).and_then(|p| p.get("up")).and_then(Value::as_bool).unwrap_or(false)
}

// ------------------------------------------------------------------ 窓

/// 起動の流れが走っている間 true（二重に走らせない）．トレイの見張りは 1 つだけ．止める操作は 1 つずつ．
static STARTING: AtomicBool = AtomicBool::new(false);
static WATCHING: AtomicBool = AtomicBool::new(false);
/// トレイを出せたか（Linux で appindicator が無いと出せない）．出せないときは，窓を閉じたら枠も終わる．
static TRAY_OK: AtomicBool = AtomicBool::new(false);
static STOPPING: Mutex<()> = Mutex::new(());
/// 閉じる小窓・状態の窓を作っている間 true（言語を読む間に二重に作らない）．
static CLOSE_OPENING: AtomicBool = AtomicBool::new(false);
static STATUS_OPENING: AtomicBool = AtomicBool::new(false);

fn build_window<'a>(app: &'a AppHandle, label: &str, page: &str, title: &str, w: f64, h: f64) -> tauri::Result<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>> {
    let cfg = app.state::<Cfg>();
    let b = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(w, h)
        // 画面の文（今の言語の分）を先に入れておく（ui/i18n.js が読む）．
        .initialization_script(&i18n::page_script())
        .additional_browser_args(&cfg.browser_args());
    #[cfg(windows)]
    let b = b.disable_drag_drop_handler();
    Ok(b)
}

/// 会話の窓を出す（あれば前へ，無ければ「起動中」の画面から作る）．
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let made = build_window(app, "main", "index.html", "Sync-Strata", 1280.0, 860.0)
        .and_then(|b| b.min_inner_size(720.0, 520.0).center().build());
    match made {
        Ok(w) => {
            let _ = w.set_focus();
        }
        Err(e) => app.state::<Cfg>().log(&format!("会話の窓を作れません: {e}")),
    }
}

/// 閉じる小窓．作る前に言語を読み直す（起動の道具を呼ぶので，窓の糸を止めないよう別の糸で）．
fn show_close_dialog(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("close") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if CLOSE_OPENING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        refresh_lang(&app.state::<Cfg>());
        let made = build_window(&app, "close", "close.html", &t("win.close"), 470.0, 480.0).and_then(|b| {
            let b = b.resizable(false).minimizable(false).maximizable(false).always_on_top(true).center();
            match app.get_webview_window("main") {
                Some(main) => b.parent(&main)?.build(),
                None => b.build(),
            }
        });
        if let Err(e) = made {
            app.state::<Cfg>().log(&format!("閉じる画面を作れません: {e}"));
        }
        CLOSE_OPENING.store(false, Ordering::SeqCst);
    });
}

/// 状態の窓．作る前に言語を読み直す（別の糸で）．
fn show_status(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("status") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.eval("window.refresh && window.refresh()");
        return;
    }
    if STATUS_OPENING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        refresh_lang(&app.state::<Cfg>());
        if let Err(e) = build_window(&app, "status", "status.html", &t("win.status"), 440.0, 400.0)
            .and_then(|b| b.resizable(false).maximizable(false).center().build())
        {
            app.state::<Cfg>().log(&format!("状態の画面を作れません: {e}"));
        }
        STATUS_OPENING.store(false, Ordering::SeqCst);
    });
}

fn close_gui_windows(app: &AppHandle) {
    for label in ["close", "main"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
}

/// 裏で動き続ける物（エンジンか dsh）があるか．初回（モデルが無い）は dsh だけが動いている．
fn background_up(v: &Value) -> bool {
    is_up(v, "engine") || is_up(v, "dsh")
}

/// 窓を閉じた後: エンジンか dsh が動いていればトレイに残り，両方止まったら終わる．
fn after_gui_closed(app: &AppHandle) {
    let cfg = app.state::<Cfg>();
    let engine_up = status_json(&cfg).map(|v| background_up(&v)).unwrap_or(false);
    if engine_up && !TRAY_OK.load(Ordering::SeqCst) {
        cfg.log("窓を閉じた．トレイが無いので枠は終わる（エンジンと dsh は動き続ける）");
        app.exit(0);
        return;
    }
    if !engine_up {
        cfg.log("窓を閉じた．エンジンも dsh も動いていないので終わる");
        app.exit(0);
        return;
    }
    cfg.log("窓を閉じた．エンジンか dsh が動いているのでトレイに残る");
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15));
        if app.get_webview_window("main").is_some() {
            continue;
        }
        let cfg = app.state::<Cfg>();
        if let Ok(v) = status_json(&cfg) {
            if !background_up(&v) {
                cfg.log("エンジンも dsh も止まったので，トレイから消えて終わる");
                app.exit(0);
                return;
            }
        }
    });
}

// ------------------------------------------------------------------ 起動の流れ（「起動中」の画面から呼ぶ）

fn progress(app: &AppHandle, line: &str) {
    let _ = app.emit_to("main", "progress", line.to_string());
}

/// gui-url の URL に TCP でつながるまで待つ（中身は取りに行かない．トークンを流さないため）．
fn wait_reachable(url: &tauri::Url, limit: Duration) -> bool {
    let host = url.host_str().unwrap_or("127.0.0.1").to_string();
    let port = url.port_or_known_default().unwrap_or(80);
    let until = Instant::now() + limit;
    while Instant::now() < until {
        if let Ok(mut addrs) = (host.as_str(), port).to_socket_addrs() {
            if let Some(a) = addrs.next() {
                if TcpStream::connect_timeout(&a, Duration::from_millis(800)).is_ok() {
                    return true;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

fn start_flow(app: &AppHandle) -> Result<tauri::Url, String> {
    let cfg = app.state::<Cfg>();
    cfg.log(&format!("起動の流れを始める（描画 {}，{} から）", cfg.gpu, cfg.gpu_from));
    progress(app, &t("prog.asking"));
    if !cfg.launcher.exists() {
        return Err(tf("err.no_launcher", &[&cfg.launcher.display().to_string()]));
    }
    let st = status_json(&cfg)?;
    if is_up(&st, "engine") && is_up(&st, "dsh") {
        let model = st.get("engine").and_then(|e| e.get("model")).and_then(Value::as_str).unwrap_or("?");
        progress(app, &tf("prog.already", &[model]));
    } else {
        progress(app, &t("prog.starting"));
        let mut child = launcher_cmd(&cfg, &["up", "--desktop-auto"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| tf("err.call", &[&cfg.python, &e.to_string()]))?;
        let t0 = Instant::now();
        // 標準エラーは別の糸で全部読む（詰まらせないため）．失敗の理由に使う．
        let mut err_pipe = child.stderr.take();
        let err_reader = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(p) = err_pipe.as_mut() {
                let _ = p.read_to_string(&mut s);
            }
            s
        });
        let mut last = String::new();
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let l = line.trim();
                if l.is_empty() {
                    continue;
                }
                let l = redact(l);
                progress(app, &l);
                last = l;
            }
        }
        let status = child.wait().map_err(|e| tf("err.wait", &[&e.to_string()]))?;
        let stderr = err_reader.join().unwrap_or_default();
        let code = status.code().unwrap_or(-1);
        cfg.log(&format!("call up --desktop-auto → {code}（{} ms）", t0.elapsed().as_millis()));
        if code != 0 {
            let why = last_line(&stderr);
            let why = if why.is_empty() { last } else { why };
            return Err(tf("err.up", &[&code.to_string(), &why]));
        }
    }
    progress(app, &t("prog.url"));
    let o = run_launcher(&cfg, &["gui-url"], true)?;
    if o.code != 0 {
        return Err(tf("err.url", &[&o.code.to_string(), &last_line(&o.stderr)]));
    }
    let raw = o.stdout.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
    let url: tauri::Url = raw.parse().map_err(|_| t("err.url_form"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(t("err.url_scheme"));
    }
    progress(app, &t("prog.connect"));
    if !wait_reachable(&url, Duration::from_secs(60)) {
        return Err(tf("err.reach", &[url.host_str().unwrap_or("?"), &url.port_or_known_default().unwrap_or(0).to_string()]));
    }
    Ok(url)
}

#[tauri::command]
fn start(app: AppHandle) {
    if STARTING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let r = start_flow(&app);
        STARTING.store(false, Ordering::SeqCst);
        match r {
            Ok(url) => {
                progress(&app, &t("boot.ready"));
                let _ = app.emit_to("main", "ready", ());
                if let Some(w) = app.get_webview_window("main") {
                    app.state::<Cfg>().log("会話の画面へ移る");
                    if let Err(e) = w.navigate(url) {
                        let _ = app.emit_to("main", "failed", tf("err.navigate", &[&e.to_string()]));
                    }
                }
            }
            Err(e) => {
                app.state::<Cfg>().log(&format!("起動に失敗: {e}"));
                let _ = app.emit_to("main", "failed", e);
            }
        }
    });
}

/// 閉じるときの 4 択．choice は gui｜dsh｜all｜cancel．
#[tauri::command]
async fn close_choice(app: AppHandle, choice: String) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let app = app2;
        let cfg = app.state::<Cfg>();
        cfg.log(&format!("閉じるときの選択: {choice}"));
        match choice.as_str() {
            "cancel" => {
                if let Some(w) = app.get_webview_window("close") {
                    let _ = w.destroy();
                }
                Ok(())
            }
            "gui" => {
                close_gui_windows(&app);
                after_gui_closed(&app);
                Ok(())
            }
            "dsh" | "all" => {
                let _guard = STOPPING.lock().unwrap_or_else(|e| e.into_inner());
                let flag = if choice == "dsh" { "--dsh" } else { "--all" };
                let o = run_launcher(&cfg, &["down", flag], false)?;
                if o.code != 0 {
                    let why = last_line(&o.stderr);
                    let why = if why.is_empty() { last_line(&o.stdout) } else { why };
                    return Err(tf("err.stop", &[&o.code.to_string(), &why]));
                }
                if choice == "all" {
                    app.exit(0);
                } else {
                    close_gui_windows(&app);
                    after_gui_closed(&app);
                }
                Ok(())
            }
            other => Err(tf("err.choice", &[other])),
        }
    })
    .await
    .map_err(|e| format!("{e}"))?
}

/// 状態の画面向け．gui-url は呼ばない（トークンを出さない）．
#[tauri::command]
async fn status_summary(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = app.state::<Cfg>();
        let mut v = status_json(&cfg)?;
        if let Some(o) = v.as_object_mut() {
            o.insert("shell".into(), serde_json::json!({ "gpu": cfg.gpu, "gpu_from": cfg.gpu_from }));
        }
        Ok(v)
    })
    .await
    .map_err(|e| format!("{e}"))?
}

/// トレイの「全て止めて終了」．
fn stop_all_and_exit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _guard = STOPPING.lock().unwrap_or_else(|e| e.into_inner());
        let cfg = app.state::<Cfg>();
        cfg.log("トレイ: 全て止めて終了");
        match run_launcher(&cfg, &["down", "--all"], false) {
            Ok(o) if o.code == 0 => app.exit(0),
            Ok(o) => {
                cfg.log(&format!("トレイ: 止められませんでした（終了コード {}）", o.code));
                show_status(&app);
            }
            Err(e) => {
                cfg.log(&format!("トレイ: {e}"));
                show_status(&app);
            }
        }
    });
}

fn make_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", t("tray.open"), true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", t("tray.status"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t("tray.quit"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &status, &quit])?;
    let mut b = TrayIconBuilder::with_id("sync-strata")
        .tooltip("Sync-Strata")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => show_main(app),
            "status" => show_status(app),
            "quit" => stop_all_and_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cfg = load_cfg(&args);
    #[cfg(target_os = "linux")]
    apply_linux_render_env(&cfg.gpu);
    cfg.log(&format!(
        "起動．起動の道具 {}，Python {}，SYNC_HOME {}，描画 {}（{}），WebView2 の引数 {}",
        cfg.launcher.display(),
        cfg.python,
        cfg.home.display(),
        cfg.gpu,
        cfg.gpu_from,
        cfg.browser_args()
    ));
    tauri::Builder::default()
        // 最初に入れる（プラグインの決まり）．2 つ目の起動はここで終わり，動いている方が窓を前に出す．
        // 2 つ目の起動に --status・--stop-all が付いていれば，トレイの「状態」「全て止めて終了」と同じことをする．
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--status") {
                app.state::<Cfg>().log("2 つ目の起動（--status）: 状態の画面を出す");
                show_status(app);
            } else if args.iter().any(|a| a == "--stop-all") {
                app.state::<Cfg>().log("2 つ目の起動（--stop-all）: 全て止めて終了");
                stop_all_and_exit(app);
            } else {
                app.state::<Cfg>().log("2 つ目の起動が来たので，窓を前に出す");
                show_main(app);
            }
        }))
        .manage(cfg)
        .invoke_handler(tauri::generate_handler![start, close_choice, status_summary])
        .setup(|app| {
            // 画面の言語を先に決める（トレイのメニューと最初の窓の文に使う）．
            {
                let cfg = app.state::<Cfg>();
                let (l, from) = resolve_lang(&cfg);
                i18n::set(l);
                cfg.log(&format!("画面の言語 {}（{from}）", l.code()));
            }
            #[cfg(target_os = "linux")]
            let tray_ok = appindicator_available();
            #[cfg(not(target_os = "linux"))]
            let tray_ok = true;
            if !tray_ok {
                app.state::<Cfg>().log("トレイの部品（appindicator）が無いので，トレイは出さない");
            } else if let Err(e) = make_tray(app) {
                app.state::<Cfg>().log(&format!("トレイを作れません: {e}"));
            } else {
                TRAY_OK.store(true, Ordering::SeqCst);
            }
            show_main(app.handle());
            {
                let cfg = app.state::<Cfg>();
                let log_path = cfg.log.clone();
                let pid = std::process::id();
                cfg.log(&format!("画面の優先度 {}（{}）", cfg.prio.name(), cfg.prio_from));
                prio::start(cfg.prio, move |line| {
                    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
                        let _ = writeln!(f, "{t} pid={pid} {line}");
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // × では閉じず，4 択を出す（閉じるのは destroy だけ）．
                api.prevent_close();
                show_close_dialog(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("Sync-Strata を組み立てられません")
        .run(|_app, event| {
            // 窓が全部無くなっても勝手に終わらない（終わるのは app.exit を呼んだときだけ）．
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
