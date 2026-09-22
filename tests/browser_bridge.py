"""Optional DOM harness for environments where browser navigation is unavailable.
Runs real source code and the real local API through a test-only Python bridge.
It does NOT test browser TLS, cookies, CORS, or CSP. Requires Python Playwright
and Chromium. See docs/VALIDATION.md. No application files or policies are changed.
"""
from playwright.sync_api import sync_playwright
from pathlib import Path
import re,json,urllib.request,urllib.error,http.cookiejar,base64,hashlib,uuid,os,shutil
root=Path(__file__).resolve().parents[1]
(root/'docs/screenshots').mkdir(parents=True,exist_ok=True)
origin=os.environ.get('TEST_ORIGIN','http://127.0.0.1:8787')
html=(root/'public/index.html').read_text()
html=re.sub(r'<link[^>]+>', '',html)
html=re.sub(r'<script[^>]+></script>', '',html)
html=html.replace('</head>','<style>'+(root/'public/game.css').read_text()+'</style></head>')
modules={str(p.relative_to(root/'public')):p.read_text() for p in (root/'public').rglob('*.js')}
results={'harness':'Offline asset injection with real loopback API bridge; no browser network navigation','errors':[]}
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
    def make_page(width,height,mobile=False):
        page=browser.new_page(viewport={'width':width,'height':height},is_mobile=mobile,has_touch=mobile)
        jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        def bridge(payload):
            headers=payload.get('headers') or {};headers['Origin']=origin
            req=urllib.request.Request(origin+payload['url'],data=payload.get('body','').encode() if 'body' in payload else None,headers=headers,method=payload.get('method','GET'))
            try:response=opener.open(req)
            except urllib.error.HTTPError as e:response=e
            return {'status':response.status,'body':response.read().decode(),'headers':dict(response.headers)}
        page.expose_function('testApiBridge',bridge)
        page.expose_function('testDigest',lambda data:list(hashlib.sha256(bytes(data)).digest()))
        page.on('pageerror',lambda e:results['errors'].append(str(e)))
        page.set_content(html,wait_until='domcontentloaded')
        page.evaluate('''() => {
          window.fetch = async (url, options={}) => { const response=await window.testApiBridge({url:String(url),...options});return new Response(response.body,{status:response.status,headers:response.headers}); };
          if (!crypto.randomUUID) crypto.randomUUID=()=>{const b=crypto.getRandomValues(new Uint8Array(16));return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');};
          if (!crypto.subtle) Object.defineProperty(crypto,'subtle',{value:{digest:async(_algorithm,buffer)=>new Uint8Array(await window.testDigest(Array.from(new Uint8Array(buffer)))).buffer}});
          const storage = () => {const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)}};
          Object.defineProperty(window,'localStorage',{value:storage()});Object.defineProperty(window,'sessionStorage',{value:storage()});
        }''')
        page.evaluate(r'''async modules=>{
          const cache={};
          const resolve=(base,path)=>{const parts=base.split('/');parts.pop();for(const p of path.split('/')){if(p==='..')parts.pop();else if(p!=='.')parts.push(p);}return parts.join('/');};
          const make=path=>{if(cache[path])return cache[path];let code=modules[path];if(code===undefined)throw Error(path);code=code.replace(/from\s+['"]([^'"]+)['"]/g,(_all,dep)=>'from '+JSON.stringify(make(resolve(path,dep))));return cache[path]=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));};
          window.testModuleUrls={};for(const path of Object.keys(modules))window.testModuleUrls[path]=make(path);
          await import(window.testModuleUrls['game.js']);
        }''',modules)
        page.wait_for_function("document.querySelector('#eligibility').textContent.includes('LOCAL PRACTICE')",timeout=15000)
        return page
    page=make_page(1440,1200)
    for i in range(24):
        action=page.evaluate('''async()=>{const {getLegalActions}=await import(window.testModuleUrls['core/rules.js']);const cells=Array.from(document.querySelectorAll('#human-board .tile')).map(x=>Number(x.dataset.e));return getLegalActions(cells)[0]}''')
        before=page.locator('#round-label').inner_text()
        page.locator(f'[data-action="{action}"]').click()
        page.wait_for_function('(v)=>document.querySelector("#round-label").textContent!==v',arg=before)
    page.screenshot(path=str(root/'docs/screenshots/desktop.png'),full_page=True)
    page.locator('[data-tab=analytics]').click()
    page.wait_for_function("document.querySelector('#analytics-kpis').children.length===4")
    page.screenshot(path=str(root/'docs/screenshots/analytics.png'),full_page=True)
    page.locator('[data-tab=replay]').click()
    page.locator('#verify-audit').click()
    page.wait_for_function("document.querySelector('#audit-status').textContent.startsWith('Verified')",timeout=20000)
    results['verification']=page.locator('#audit-status').inner_text()
    page.locator('#replay-slider').fill('5');page.locator('#replay-slider').dispatch_event('input')
    assert 'REPLAY' in page.locator('#round-label').inner_text()
    page.locator('#return-live').click()
    assert 'REPLAY' not in page.locator('#round-label').inner_text()
    page.locator('[data-tab=leaderboard]').click();page.wait_for_function("document.querySelector('#leader-table').textContent.includes('No verified')")
    page.locator('[data-scope=channel]').click();page.wait_for_function("document.querySelector('#leader-table').textContent.includes('participating')")
    # Exercise keyboard from the focusable game control area.
    page.locator('[data-tab=decision]').click();page.locator('#play-region').focus()
    action=page.evaluate('''async()=>{const {getLegalActions}=await import(window.testModuleUrls['core/rules.js']);return getLegalActions(Array.from(document.querySelectorAll('#human-board .tile')).map(x=>Number(x.dataset.e)))[0]}''')
    before=page.locator('#round-label').inner_text();page.keyboard.press(['ArrowUp','ArrowRight','ArrowDown','ArrowLeft'][action])
    page.wait_for_function('(v)=>document.querySelector("#round-label").textContent!==v',arg=before)
    mobile=make_page(390,844,True)
    mobile.screenshot(path=str(root/'docs/screenshots/mobile.png'),full_page=True)
    results['mobileHorizontalOverflow']=mobile.evaluate('document.documentElement.scrollWidth>window.innerWidth')
    results['desktopHorizontalOverflow']=page.evaluate('document.documentElement.scrollWidth>window.innerWidth')
    results['playedRounds']=25
    results['passed']=not results['errors'] and not results['mobileHorizontalOverflow']
    print(json.dumps(results,indent=2))
    (root/'docs/browser-test-report.json').write_text(json.dumps(results,indent=2))
    browser.close()
