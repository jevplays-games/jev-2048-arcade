"""Optional normal-browser smoke check. Run a local server first.
Requires: pip install playwright; python -m playwright install chromium
This harness is supplied but normal navigation was not executable in the build sandbox.
"""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright

origin = os.environ.get('TEST_ORIGIN', 'http://127.0.0.1:8787')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width':1440,'height':1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(origin, wait_until='networkidle')
    page.wait_for_function("document.querySelector('#eligibility').textContent.includes('LOCAL PRACTICE')")
    assert page.locator('#human-board .tile').count() == 16
    assert page.locator('#jev-board .tile').count() == 16
    for _ in range(10):
        action = page.evaluate("""async()=>{
          const {getLegalActions}=await import('/core/rules.js');
          return getLegalActions(Array.from(document.querySelectorAll('#human-board .tile')).map(t=>Number(t.dataset.e)))[0];
        }""")
        before = page.locator('#round-label').inner_text()
        page.locator(f'[data-action="{action}"]').click()
        page.wait_for_function('(v)=>document.querySelector("#round-label").textContent!==v', arg=before)
    page.locator('[data-tab=analytics]').click()
    page.wait_for_function("document.querySelector('#analytics-kpis').children.length===4")
    page.locator('[data-tab=replay]').click()
    page.locator('#verify-audit').click()
    page.wait_for_function("document.querySelector('#audit-status').textContent.startsWith('Verified')")
    page.set_viewport_size({'width':390,'height':844})
    assert not page.evaluate('document.documentElement.scrollWidth>window.innerWidth')
    assert not errors, errors
    browser.close()
    print('Normal-browser smoke checks passed.')
