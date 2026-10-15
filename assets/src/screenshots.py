"""Capture README screenshots from an already running local practice server.

Usage: python assets/src/screenshots.py http://127.0.0.1:8811
Requires Playwright and its installed Chromium browser. Does not start a server.
"""

import argparse
from pathlib import Path
import struct
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
CAPTURES = (
    ("desktop", 1440, 1000),
    ("mobile", 390, 844),
    ("analytics", 1440, 1000),
)


def capture(browser, origin, name, width, height):
    context = browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=1,
        service_workers="block",
    )
    try:
        # Allow the supplied server only, including its self-hosted fonts.
        server = urlsplit(origin)
        context.route(
            "**/*",
            lambda route: route.continue_()
            if urlsplit(route.request.url)[:2] == server[:2]
            else route.abort(),
        )
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(origin, wait_until="load")
        page.wait_for_function(
            "(label) => document.querySelector('#eligibility')"
            "?.textContent.includes(label)",
            arg="LOCAL PRACTICE",
        )

        for move in range(20):
            actions = page.evaluate("""async () => {
                const {getLegalActions} = await import('/core/rules.js');
                const cells = Array.from(
                    document.querySelectorAll('#human-board .tile'),
                    tile => Number(tile.dataset.e)
                );
                return getLegalActions(cells);
            }""")
            assert actions, f"{name}: no legal actions after {move} moves"
            before = page.locator("#round-label").text_content()
            page.locator(f'[data-action="{actions[0]}"]').click()
            # Function expressions work with the page's eval-restricting CSP.
            page.wait_for_function(
                "(previous) => document.querySelector('#round-label')"
                ".textContent !== previous",
                arg=before,
            )

        if name == "analytics":
            page.locator("[data-tab=analytics]").click()
            page.locator("#refresh-analytics").click()
            page.wait_for_function(
                "(count) => document.querySelectorAll('.chart svg').length === count"
                " && !document.querySelector('#refresh-analytics').disabled",
                arg=4,
            )

        page.evaluate("() => document.fonts.ready")
        page.wait_for_timeout(400)
        assert page.locator(".jv-wordmark").text_content().lower() == "jevplay.games"
        assert page.locator(".jv-title").text_content() == "Slide Score"
        assert page.title() == "Slide Score · jevplay.games"
        assert not errors, f"{name}: page errors: {errors}"

        # Capture to memory so errors during capture also prevent saving.
        page.evaluate("() => window.scrollTo(0, 0)")
        page.wait_for_function("() => window.scrollY === 0")
        page.wait_for_timeout(100)
        # A full_page capture restarted the opponent board's tile animations mid-capture, so its newest
        # tile came out half-popped. Grow the viewport to the page height instead, let every animation
        # settle, and capture that viewport.
        full_height = page.evaluate("() => document.documentElement.scrollHeight")
        page.set_viewport_size({"width": width, "height": full_height})
        page.wait_for_timeout(100)
        page.wait_for_function(
            "() => document.getAnimations().every(a => a.playState !== 'running')"
        )
        png = page.screenshot(full_page=False, type="png", animations="disabled")
        assert not errors, f"{name}: page errors: {errors}"
        output = ROOT / "docs" / "screenshots" / f"{name}.png"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(png)
        pixel_width, pixel_height = struct.unpack(">II", png[16:24])
        print(f"{output.relative_to(ROOT)} ({pixel_width} x {pixel_height} px)")
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin", help="Origin of the running local practice server")
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if (origin.scheme not in {"http", "https"} or not origin.netloc
            or origin.path not in {"", "/"} or origin.query or origin.fragment):
        parser.error("Provide a server origin, for example http://127.0.0.1:8811")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, width, height in CAPTURES:
                capture(browser, args.origin, name, width, height)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
