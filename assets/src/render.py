"""Render local artwork with Playwright's installed Chromium; no arguments."""
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
# Source, destination, viewport width, viewport height, device scale factor.
PAGES = [
    ("assets/src/banner.html", "assets/banner.png", 1280, 420, 2),
    ("assets/src/social.html", "assets/social-preview.png", 1280, 640, 1),
    ("assets/src/og.html", "public/brand/og.png", 1200, 630, 1),
]


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for source, destination, width, height, scale in PAGES:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=scale,
                )
                try:
                    # Keep rendering offline even if a future page adds a URL.
                    context.route("http://**/*", lambda route: route.abort())
                    context.route("https://**/*", lambda route: route.abort())
                    page = context.new_page()
                    page.goto((ROOT / source).as_uri(), wait_until="load")
                    page.evaluate("() => document.fonts.ready")
                    output = ROOT / destination
                    output.parent.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(output), full_page=False)
                finally:
                    context.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
