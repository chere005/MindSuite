// App sign-in, the shell's half (RFC 8252 section 7.3, the loopback return).
//
// The web page signs in through the suite's /account/app/ in the system browser. That page ends in a redirect to
// http://127.0.0.1:<port>/signin?code=...&state=...; this file is the one-shot listener that catches it. It binds
// 127.0.0.1 only, on a port the system picks, waits for ONE request that carries the exact 256-bit state the page made
// up, hands its query string to the page and closes. Any other request gets a plain 400 or 404 and the listener keeps
// waiting. Nothing here reads, logs or prints a code: the query string goes to the page and nowhere else, and the
// answer page reflects nothing from the request.
//
// std only (no tauri, no crate), so `rustc --test` builds and runs this file alone (desktop/test-signin.sh).
// The shell's commands are in main.rs.

use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A sign-in that is listening: the socket, the state it expects and the flag that ends the wait.
pub struct Pending {
    listener: TcpListener,
    state: String,
    cancel: Arc<AtomicBool>,
}

impl Pending {
    /// The loopback port the system picked.
    pub fn port(&self) -> u16 {
        self.listener.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    /// The flag that makes `wait` answer `Ok(None)`.
    pub fn canceller(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
}

/// The state the page makes is 32 random bytes in base64url (43 characters); the bounds are 43 to 128 of [A-Za-z0-9_-].
pub fn valid_state(s: &str) -> bool {
    (43..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Bind 127.0.0.1 (never another address) on port 0 and wait for `state`.
pub fn listen(state: &str) -> Result<Pending, String> {
    if !valid_state(state) {
        return Err("invalid state".to_string());
    }
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).map_err(|_| "could not listen".to_string())?;
    listener.set_nonblocking(true).map_err(|_| "could not listen".to_string())?;
    Ok(Pending { listener, state: state.to_string(), cancel: Arc::new(AtomicBool::new(false)) })
}

/// The first value of `name` in a raw query string, as written (no decoding: the state and the code are URL-safe).
pub fn query_param<'a>(q: &'a str, name: &str) -> Option<&'a str> {
    for pair in q.split('&') {
        let (k, v) = match pair.find('=') {
            Some(i) => (&pair[..i], &pair[i + 1..]),
            None => (pair, ""),
        };
        if k == name {
            return Some(v);
        }
    }
    None
}

/// Equal without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let msg = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        status,
        body.len(),
        body
    );
    let _ = stream.write_all(msg.as_bytes());
    let _ = stream.flush();
}

fn page(title: &str, text: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{t}</title><style>body{{font:16px/1.45 system-ui,sans-serif;margin:0;padding:2rem 1rem;background:#111;color:#eee}}\
         main{{max-width:30rem;margin:0 auto}}</style></head><body><main><p>{x}</p></main></body></html>",
        t = escape(title),
        x = escape(text)
    )
}

/// What one connection asked for: the request line's query when it is `GET /signin[?q]`, else None.
fn read_request(stream: &mut TcpStream) -> Option<Option<String>> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    while buf.len() < 8192 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => return None,
        }
    }
    let line_end = buf.windows(2).position(|w| w == b"\r\n")?;
    let line = std::str::from_utf8(&buf[..line_end]).ok()?;
    let mut parts = line.split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || method != "GET" || !version.starts_with("HTTP/1.") {
        return Some(None);
    }
    let (path, query) = match target.find('?') {
        Some(i) => (&target[..i], Some(target[i + 1..].to_string())),
        None => (target, None),
    };
    if path != "/signin" {
        return Some(None);
    }
    Some(Some(query.unwrap_or_default()))
}

/// Wait for the return. `Ok(Some(query))` is the first request that carries our state (the query is returned whole, as
/// `code=..&state=..` or `error=..&state=..`); `Ok(None)` is a cancel; `Err("timeout")` is `limit` gone by.
pub fn wait(p: Pending, limit: Duration, app_name: &str) -> Result<Option<String>, String> {
    let started = Instant::now();
    loop {
        if p.cancel.load(Ordering::SeqCst) {
            return Ok(None);
        }
        if started.elapsed() >= limit {
            return Err("timeout".to_string());
        }
        match p.listener.accept() {
            Ok((mut stream, _)) => match read_request(&mut stream) {
                None => {}
                Some(None) => respond(&mut stream, "404 Not Found", &page("Not found", "Not found.")),
                Some(Some(q)) => {
                    if query_param(&q, "state").map_or(false, |s| same(s, &p.state)) {
                        let text = format!("{a} has your sign-in. You can close this tab and go back to {a}.", a = app_name);
                        respond(&mut stream, "200 OK", &page(app_name, &text));
                        return Ok(Some(q));
                    }
                    respond(&mut stream, "400 Bad Request", &page("Not a sign-in", "This page is not part of a sign-in."));
                }
            },
            Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn host_ok(host: &str) -> bool {
    !host.is_empty() && host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn local_host_ok(host_port: &str) -> bool {
    let (host, port) = match host_port.find(':') {
        Some(i) => (&host_port[..i], Some(&host_port[i + 1..])),
        None => (host_port, None),
    };
    (host == "127.0.0.1" || host == "localhost")
        && port.map_or(true, |p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Is this a page the shell may open? An https address of the suite's account pages (`/account/`, `/account/app/`,
/// optionally under `/test` or `/dev`), or the same on 127.0.0.1 or localhost over http for the local harness.
pub fn check_url(url: &str) -> Result<(), String> {
    let bad = || Err("not an account page".to_string());
    if url.len() > 2048 {
        return bad();
    }
    let (secure, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return bad();
    };
    let slash = match rest.find('/') {
        Some(i) => i,
        None => return bad(),
    };
    let (host_port, path_query) = rest.split_at(slash);
    if secure && !host_ok(host_port) {
        return bad();
    }
    if !secure && !local_host_ok(host_port) {
        return bad();
    }
    let (path, query) = match path_query.find('?') {
        Some(i) => (&path_query[..i], Some(&path_query[i + 1..])),
        None => (path_query, None),
    };
    let tail = path.strip_prefix("/test").or_else(|| path.strip_prefix("/dev")).unwrap_or(path);
    if tail != "/account/" && tail != "/account/app/" {
        return bad();
    }
    if let Some(q) = query {
        if !q.bytes().all(|b| b.is_ascii_alphanumeric() || b"._~%&=+-".contains(&b)) {
            return bad();
        }
    }
    Ok(())
}

/// Open `url` in the system's default browser: no shell, the address as one argument, after `check_url`.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    check_url(url)?;
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(url);
        c
    } else if cfg!(target_os = "windows") {
        let mut c = Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler").arg(url);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    let mut child = cmd.spawn().map_err(|_| "could not open the browser".to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    const STATE: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ-_";

    fn get(port: u16, target: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(s, "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", target, port).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn valid_state_table() {
        assert!(valid_state(STATE));
        assert!(valid_state(&"a".repeat(43)));
        assert!(valid_state(&"a".repeat(128)));
        assert!(!valid_state(&"a".repeat(42)));
        assert!(!valid_state(&"a".repeat(129)));
        assert!(!valid_state(&format!("{}+", "a".repeat(43))));
        assert!(!valid_state(&format!("{}/", "a".repeat(43))));
        assert!(!valid_state(&format!("{} ", "a".repeat(43))));
        assert!(!valid_state(""));
    }

    #[test]
    fn check_url_accepts_the_suite_pages() {
        for u in [
            "https://seancheren.com/account/",
            "https://seancheren.com/account/app/?app=calmind&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fsignin&state=a-b_c&code_challenge=x&code_challenge_method=S256",
            "https://test.seancheren.com/account/app/",
            "https://seancheren.com/test/account/",
            "https://seancheren.com/dev/account/app/?a=b",
            "http://127.0.0.1:8905/account/app/?app=calmind",
            "http://127.0.0.1/account/",
            "http://localhost:8905/test/account/",
        ] {
            assert!(check_url(u).is_ok(), "{}", u);
        }
    }

    #[test]
    fn check_url_refuses_everything_else() {
        let long = format!("https://seancheren.com/account/?{}", "a".repeat(2049));
        for u in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://seancheren.com/account/x",
            "https://seancheren.com/account",
            "https://seancheren.com/other/",
            "https://seancheren.com/test/test/account/",
            "https://seancheren.com/account/#frag",
            "https://seancheren.com/account/?a=\"b",
            "https://seancheren.com/account/?a=b c",
            "https://seancheren.com/account/?a=b'c",
            "https://user@seancheren.com/account/",
            "https://seancheren.com:443/account/",
            "https://Seancheren.com/account/",
            "https:///account/",
            "http://seancheren.com/account/",
            "http://127.0.0.1:123456/account/",
            "http://127.0.0.1:80a/account/",
            "http://127.0.0.1.evil.com/account/",
            "ftp://seancheren.com/account/",
            "",
            long.as_str(),
        ] {
            assert!(check_url(u).is_err(), "{}", u);
        }
    }

    #[test]
    fn query_param_reads_the_first_value() {
        assert_eq!(query_param("code=a&state=b", "state"), Some("b"));
        assert_eq!(query_param("code=a&state=b&state=c", "state"), Some("b"));
        assert_eq!(query_param("code=a", "state"), None);
        assert_eq!(query_param("flag&state=", "state"), Some(""));
        assert_eq!(query_param("xstate=a", "state"), None);
    }

    #[test]
    fn listen_binds_loopback_only() {
        assert!(listen("short").is_err());
        let p = listen(STATE).unwrap();
        assert!(p.port() >= 1024);
        let addr = p.listener.local_addr().unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.ip().to_string(), "127.0.0.1");
    }

    #[test]
    fn a_wrong_state_gets_400_then_the_right_one_gets_200_and_the_query() {
        let p = listen(STATE).unwrap();
        let port = p.port();
        let code = "c0de".repeat(16);
        let q = format!("code={}&state={}", code, STATE);
        let sent = q.clone();
        let client = std::thread::spawn(move || {
            let wrong = get(port, &format!("/signin?code={}&state=wrong", "0".repeat(64)));
            let none = get(port, "/signin");
            let favicon = get(port, "/favicon.ico");
            let post = {
                let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
                s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                write!(s, "POST /signin?state={} HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n", STATE).unwrap();
                let mut o = String::new();
                let _ = s.read_to_string(&mut o);
                o
            };
            let right = get(port, &format!("/signin?{}", sent));
            (wrong, none, favicon, post, right)
        });
        let got = wait(p, Duration::from_secs(10), "CalMind <&>").unwrap();
        assert_eq!(got.as_deref(), Some(q.as_str()));
        let (wrong, none, favicon, post, right) = client.join().unwrap();
        assert!(wrong.starts_with("HTTP/1.1 400"), "{}", wrong);
        assert!(none.starts_with("HTTP/1.1 400"), "{}", none);
        assert!(favicon.starts_with("HTTP/1.1 404"), "{}", favicon);
        assert!(post.starts_with("HTTP/1.1 404"), "{}", post);
        assert!(right.starts_with("HTTP/1.1 200"), "{}", right);
        assert!(right.contains("CalMind &lt;&amp;&gt; has your sign-in. You can close this tab and go back to CalMind &lt;&amp;&gt;."));
        assert!(!right.contains(&code), "the answer page must not hold the code");
        assert!(!right.contains(STATE), "the answer page must not hold the state");
        assert!(!wrong.contains("wrong") || !wrong.contains("code="), "nothing is reflected");
        assert!(right.contains("Referrer-Policy: no-referrer"));
        assert!(right.contains("Cache-Control: no-store"));
    }

    #[test]
    fn an_error_return_with_our_state_is_handed_over_too() {
        let p = listen(STATE).unwrap();
        let port = p.port();
        let q = format!("error=access_denied&state={}", STATE);
        let sent = q.clone();
        let client = std::thread::spawn(move || get(port, &format!("/signin?{}", sent)));
        assert_eq!(wait(p, Duration::from_secs(10), "CalMind").unwrap().as_deref(), Some(q.as_str()));
        assert!(client.join().unwrap().starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn the_cancel_flag_ends_the_wait_quickly() {
        let p = listen(STATE).unwrap();
        let flag = p.canceller();
        let started = Instant::now();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            flag.store(true, Ordering::SeqCst);
        });
        assert_eq!(wait(p, Duration::from_secs(30), "CalMind").unwrap(), None);
        t.join().unwrap();
        assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
    }

    #[test]
    fn the_limit_is_a_timeout() {
        let p = listen(STATE).unwrap();
        assert_eq!(wait(p, Duration::from_millis(300), "CalMind"), Err("timeout".to_string()));
    }

    #[test]
    fn a_connection_that_says_nothing_does_not_end_the_wait() {
        let p = listen(STATE).unwrap();
        let port = p.port();
        let q = format!("code={}&state={}", "ab".repeat(32), STATE);
        let sent = q.clone();
        let client = std::thread::spawn(move || {
            let idle = TcpStream::connect(("127.0.0.1", port)).unwrap();
            drop(idle);
            let _junk = {
                let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
                let _ = s.write_all(b"\x00\x01garbage\r\n\r\n");
                s
            };
            get(port, &format!("/signin?{}", sent))
        });
        assert_eq!(wait(p, Duration::from_secs(15), "CalMind").unwrap().as_deref(), Some(q.as_str()));
        assert!(client.join().unwrap().starts_with("HTTP/1.1 200"));
    }
}
