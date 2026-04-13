from pathlib import Path


def _load_netscape_cookies(cookies_path):
    """把 Netscape cookie 文件转换为 Playwright 可识别格式。"""
    cookies = []
    with open(cookies_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            parts = line.split("\t")
            if len(parts) < 7:
                continue

            domain, _, path, secure, expires, name, value = parts[:7]
            if not name:
                continue

            cookie = {
                "name": name,
                "value": value,
                "domain": domain,
                "path": path or "/",
                "secure": secure.upper() == "TRUE",
                "httpOnly": False,
            }

            try:
                expires_ts = int(expires)
                if expires_ts > 0:
                    cookie["expires"] = expires_ts
            except (TypeError, ValueError):
                pass

            cookies.append(cookie)

    return cookies


def load_playwright_cookies_from_netscape(cookies_path=None):
    """只读取 Netscape cookie 文件，返回 Playwright 可识别格式。"""
    if cookies_path is None:
        script_dir = Path(__file__).resolve().parent
        cookies_path = script_dir / "cookies/instagram_netscape_cookies.txt"
    else:
        cookies_path = Path(cookies_path)

    cookies = _load_netscape_cookies(cookies_path)
    print(f"已加载 Netscape cookies: {cookies_path.resolve()}")
    return cookies
