#!/usr/bin/env python3
"""Render the local brand SVG with installed Playwright Chromium, offline.

Run from any directory: python3 assets/src/icons.py
"""

import base64
from pathlib import Path

from playwright.sync_api import sync_playwright


BRAND = Path(__file__).resolve().parents[2] / "public" / "brand"


def main() -> None:
    svg = base64.b64encode((BRAND / "icon.svg").read_bytes()).decode("ascii")
    source = f"data:image/svg+xml;base64,{svg}"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            context = browser.new_context(
                viewport={"width": 180, "height": 180},
                device_scale_factor=1,
                offline=True,
            )
            page = context.new_page()
            for filename, size, mark_size, background in (
                ("favicon-32.png", 32, 32, "transparent"),
                ("apple-touch-icon.png", 180, 126, "#F386A1"),
            ):
                page.set_content(f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body {{ margin: 0; padding: 0; background: transparent; }}
#icon {{ width: {size}px; height: {size}px; background: {background};
         display: flex; align-items: center; justify-content: center; }}
img {{ display: block; width: {mark_size}px; height: {mark_size}px; }}
</style></head><body><div id="icon">
<img src="{source}" width="{mark_size}" height="{mark_size}" alt="">
</div></body></html>""")
                page.locator("img").evaluate("image => image.decode()")
                page.locator("#icon").screenshot(
                    path=str(BRAND / filename),
                    omit_background=True,
                    animations="disabled",
                    scale="css",
                )
        finally:
            browser.close()


if __name__ == "__main__":
    main()
