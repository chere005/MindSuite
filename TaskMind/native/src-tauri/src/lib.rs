use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

// Until the standalone web app is deployed at /TaskMind/, the shells open the working interim page that seancheren-site
// serves at /taskmind/ (same accounts, same session). A build still opens exactly one of the two paths, fixed at compile time.
const PRODUCTION: &str = "https://seancheren.com/taskmind/";
const APP_PATHS: [&str; 2] = ["/taskmind/", "/TaskMind/"];
// One address per build, fixed at compile time: a build can only reach the address it was built for.
const START: &str = match option_env!("TASKMIND_APP_URL") {
    Some(url) => url,
    None => PRODUCTION,
};

// Production, the test instance, and (debug builds only) the disposable local preview.
fn approved_start(url: &Url) -> bool {
    let site = url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && matches!(url.host_str(), Some("seancheren.com" | "test.seancheren.com"));
    let preview = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(8870);
    (site || preview)
        && url.username().is_empty()
        && url.password().is_none()
        && APP_PATHS.contains(&url.path())
        && url.query().is_none()
        && url.fragment().is_none()
}

// The shared sign-in page lives beside the app, on the same origin. Exactly this path, a query allowed, never a fragment.
const ACCOUNT_PATH: &str = "/account/";

// The remote page has no native IPC permissions. Restrict navigations as well:
// the build's own origin, inside the app's own path, plus the sign-in page at exactly /account/.
fn allowed_url(start: &Url, url: &Url) -> bool {
    url.scheme() == start.scheme()
        && url.host_str() == start.host_str()
        && url.port_or_known_default() == start.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
        && {
            let base = start.path().trim_end_matches('/');
            url.path() == base
                || url.path().starts_with(&format!("{base}/"))
                || (url.path() == ACCOUNT_PATH && url.fragment().is_none())
        }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start: Url = START.parse().expect("TASKMIND_APP_URL is not a URL");
    assert!(approved_start(&start), "TASKMIND_APP_URL is not an approved TaskMind address");
    tauri::Builder::default()
        .setup(move |app| {
            let origin = start.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start.clone()))
                .title("TaskMind")
                .on_navigation(move |url| allowed_url(&origin, url));
            // A phone's webview fills the screen; a desktop-sized frame there lays the page out 1120pt wide, off the screen.
            #[cfg(desktop)]
            let window = window.inner_size(1120.0, 820.0).min_inner_size(360.0, 540.0);
            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Unable to start TaskMind");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(input: &str) -> Url {
        input.parse().unwrap()
    }

    #[test]
    fn only_the_private_https_app_is_navigable() {
        let start = url("https://seancheren.com/TaskMind/");
        for input in ["https://seancheren.com/TaskMind/", "https://seancheren.com/TaskMind/?tab=board"] {
            assert!(allowed_url(&start, &url(input)), "{input}");
        }
        for input in ["http://seancheren.com/TaskMind/", "https://seancheren.com/", "https://evil.example/TaskMind/", "https://seancheren.com.evil.example/TaskMind/", "https://seancheren.com:8443/TaskMind/", "https://user@seancheren.com/TaskMind/", "https://seancheren.com/TaskMind/../status/", "https://test.seancheren.com/TaskMind/"] {
            assert!(!allowed_url(&start, &url(input)), "{input}");
        }
    }

    #[test]
    fn the_interim_page_is_what_a_build_opens_today() {
        let start = url(PRODUCTION);
        assert!(approved_start(&start));
        for input in ["https://seancheren.com/taskmind/", "https://seancheren.com/taskmind/?logout", "https://seancheren.com/taskmind/api.php"] {
            assert!(allowed_url(&start, &url(input)), "{input}");
        }
        for input in ["http://seancheren.com/taskmind/", "https://seancheren.com/", "https://seancheren.com/TaskMind/", "https://seancheren.com/taskmindx/", "https://seancheren.com/todo/", "https://seancheren.com/taskmind/../todo/", "https://evil.example/taskmind/", "https://seancheren.com.evil.example/taskmind/"] {
            assert!(!allowed_url(&start, &url(input)), "{input}");
        }
        assert!(approved_start(&url("https://test.seancheren.com/taskmind/")));
        assert!(!approved_start(&url("https://seancheren.com/taskmind")));
    }

    #[test]
    fn a_test_build_reaches_only_the_test_instance() {
        let start = url("https://test.seancheren.com/TaskMind/");
        assert!(allowed_url(&start, &url("https://test.seancheren.com/TaskMind/?tab=board")));
        for input in ["https://seancheren.com/TaskMind/", "http://test.seancheren.com/TaskMind/", "https://test.seancheren.com/", "https://test.seancheren.com.evil.example/TaskMind/"] {
            assert!(!allowed_url(&start, &url(input)), "{input}");
        }
    }

    #[test]
    fn the_sign_in_page_is_reachable_on_the_same_origin_only() {
        for start in ["https://seancheren.com/taskmind/", "https://seancheren.com/TaskMind/", "https://test.seancheren.com/TaskMind/"] {
            let start = url(start);
            let host = start.host_str().unwrap().to_string();
            for path in ["/account/", "/account/?next=%2FTaskMind%2F", "/account/?"] {
                let input = format!("https://{host}{path}");
                assert!(allowed_url(&start, &url(&input)), "{input}");
            }
            for path in [
                "/account", "/accounts/", "/account/evil", "/account/evil/", "/account/../x", "/account/%2e%2e/x", "/account/..%2fx", "/account%2f", "/account%2F",
                "/%2faccount/", "//account/", "///account/", "/Account/", "/account//", "/account/#x", "/account/?a=1#x", "/x/account/",
            ] {
                let input = format!("https://{host}{path}");
                assert!(!allowed_url(&start, &url(&input)), "{input}");
            }
            let other = [
                format!("http://{host}/account/"),
                format!("https://{host}:8443/account/"),
                format!("https://user@{host}/account/"),
                format!("https://user:pw@{host}/account/"),
                format!("https://{host}@evil.example/account/"),
                format!("https://evil.example@{host}/account/"),
                format!("https://{host}.evil.example/account/"),
                format!("https://evil.example/account/?h={host}"),
                format!("https://evil.example/account/"),
            ];
            for input in other {
                let allowed = allowed_url(&start, &url(&input));
                // userinfo forms keep the username, so they are refused even when the host part matches.
                assert!(!allowed, "{input}");
            }
        }
        // the other deployment's host is not reachable from a test build, nor the reverse
        assert!(!allowed_url(&url("https://test.seancheren.com/TaskMind/"), &url("https://seancheren.com/account/")));
        assert!(!allowed_url(&url("https://seancheren.com/taskmind/"), &url("https://test.seancheren.com/account/")));
        // start addresses do not widen
        assert!(!approved_start(&url("https://seancheren.com/account/")));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn the_local_preview_may_reach_its_own_sign_in_page_only() {
        let start = url("http://127.0.0.1:8870/TaskMind/");
        assert!(allowed_url(&start, &url("http://127.0.0.1:8870/account/")));
        assert!(!allowed_url(&start, &url("http://127.0.0.1:8871/account/")));
        assert!(!allowed_url(&start, &url("https://127.0.0.1:8870/account/")));
    }

    #[test]
    fn only_approved_start_addresses_are_accepted() {
        for input in ["https://seancheren.com/TaskMind/", "https://test.seancheren.com/TaskMind/"] {
            assert!(approved_start(&url(input)), "{input}");
        }
        for input in ["http://seancheren.com/TaskMind/", "https://seancheren.com/", "https://seancheren.com/TaskMind", "https://seancheren.com/TaskMind/?x=1", "https://seancheren.com/TaskMind/#x", "https://user@seancheren.com/TaskMind/", "https://seancheren.com:8443/TaskMind/", "https://dev.seancheren.com/TaskMind/", "https://evil.example/TaskMind/", "http://127.0.0.1:8871/TaskMind/", "http://localhost:8870/TaskMind/"] {
            assert!(!approved_start(&url(input)), "{input}");
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_builds_may_open_the_local_preview() {
        let start = url("http://127.0.0.1:8870/TaskMind/");
        assert!(approved_start(&start));
        assert!(allowed_url(&start, &url("http://127.0.0.1:8870/TaskMind/api.php")));
        assert!(!allowed_url(&start, &url("http://127.0.0.1:8870/")));
        assert!(!allowed_url(&start, &url("https://seancheren.com/TaskMind/")));
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn release_builds_never_open_the_local_preview() {
        assert!(!approved_start(&url("http://127.0.0.1:8870/TaskMind/")));
    }
}
