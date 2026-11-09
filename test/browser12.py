# Keyboard navigation: sidebar arrows, Alt+number, help, search, cards, table arrows, editable cell (Enter edits, focus returns).
import subprocess, time, os
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-persist.js"></script>')
open(ROOT+'/test/harness-b12.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8799','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]; bad=[]
def ok(n,c): print(('PASS ' if c else 'FAIL ')+n); (None if c else bad.append(n))
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_context(viewport={'width':1500,'height':1000}).new_page()
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None); pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e))); pg.on('dialog',lambda d: d.accept())
    pg.add_init_script("new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});")
    pg.goto('http://localhost:8799/test/harness-b12.html'); pg.wait_for_timeout(1500)
    pg.evaluate("document.getElementById('introSplash')&&document.getElementById('introSplash').click()"); pg.wait_for_timeout(1500)
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'P.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=20000); pg.wait_for_timeout(1500)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(2500)
    active=lambda: pg.evaluate("document.querySelector('.panel.active').id")
    foc=lambda: pg.evaluate("(()=>{const a=document.activeElement;return a?(a.dataset.panel||a.id||a.tagName):''})()")
    # --- sidebar
    pg.focus('#nav button[data-panel="dashboard"]'); pg.keyboard.press('ArrowDown'); ok('sidebar ArrowDown moves focus to Vehicles', foc()=='vehicles')
    pg.keyboard.press('Enter'); pg.wait_for_timeout(300); ok('Enter opens Vehicles', active()=='panel-vehicles')
    pg.keyboard.press('End'); ok('End goes to last item', foc()=='pilot')
    pg.keyboard.press('Home'); ok('Home goes to first item', foc()=='dashboard')
    # --- Alt+number / Alt+arrows
    pg.keyboard.press('Alt+3'); pg.wait_for_timeout(300); ok('Alt+3 opens Drivers', active()=='panel-drivers')
    pg.keyboard.press('Alt+ArrowDown'); pg.wait_for_timeout(300); ok('Alt+Down opens next screen (Clients)', active()=='panel-clients')
    pg.keyboard.press('Alt+ArrowUp'); pg.wait_for_timeout(300); ok('Alt+Up goes back (Drivers)', active()=='panel-drivers')
    # --- help
    pg.keyboard.press('?'); ok('? opens shortcuts', pg.locator('.kn-help').count()==1)
    pg.keyboard.press('Escape'); ok('Esc closes shortcuts', pg.locator('.kn-help').count()==0)
    # --- search
    pg.keyboard.press('Alt+1'); pg.wait_for_timeout(500); pg.focus('#nav button[data-panel="dashboard"]')
    pg.keyboard.press('/'); pg.wait_for_timeout(300)
    ok('/ opens search and focuses its box', pg.evaluate("document.activeElement.tagName")=='INPUT')
    pg.keyboard.type('a/b?'); ok('typing / and ? inside a box is not hijacked', pg.locator('.kn-help').count()==0 and pg.evaluate("document.activeElement.value")=='a/b?')
    pg.keyboard.press('Escape')
    # --- dashboard card by keyboard
    pg.evaluate("document.activeElement.blur()")
    n=pg.locator('.card[data-goto][tabindex="0"]').count(); ok('dashboard cards are keyboard reachable (%d)'%n, n>0)
    if n:
        pg.locator('.card[data-goto]').first.focus(); pg.keyboard.press('Enter'); pg.wait_for_timeout(500)
        ok('Enter on a card opens its records', active()!='panel-dashboard')
    # --- table arrows on a real table
    pg.keyboard.press('Alt+9'); pg.wait_for_timeout(500)
    pg.keyboard.press('Alt+1'); pg.wait_for_timeout(300); pg.keyboard.press('Alt+2'); pg.wait_for_timeout(500)
    btns=pg.locator('.panel.active table tbody tr button')
    if btns.count()>=2:
        btns.first.focus(); r0=pg.evaluate("document.activeElement.closest('tr').rowIndex")
        pg.keyboard.press('ArrowDown'); r1=pg.evaluate("document.activeElement.closest('tr')?document.activeElement.closest('tr').rowIndex:-1")
        ok('ArrowDown moves to the next row in a table', r1==r0+1)
        pg.keyboard.press('ArrowUp'); ok('ArrowUp moves back', pg.evaluate("document.activeElement.closest('tr').rowIndex")==r0)
    else: print('SKIP vehicles table arrows (no row buttons)')
    # --- Pilot loans grid: Enter edits, focus returns
    pg.click('.nav button[data-panel="pilot"]'); pg.wait_for_timeout(800)
    pg.click('#panel-pilot [data-tab="loans"]'); pg.wait_for_timeout(500)
    cells=pg.locator('#panel-pilot [data-g="cell"][data-t="loanlist"]')
    ok('editable cells are reachable', cells.count()>0 and cells.first.get_attribute('tabindex') is not None)
    if cells.count()>1:
        c=cells.first; rid=c.get_attribute('data-r'); key=c.get_attribute('data-c')
        c.focus(); pg.keyboard.press('Enter'); pg.wait_for_timeout(200)
        ok('Enter starts editing', pg.locator('#panel-pilot [data-t="loanlist"] input,#panel-pilot [data-t="loanlist"] select').count()>=1)
        pg.keyboard.press('Control+a'); pg.keyboard.type('KEYTEST'); pg.keyboard.press('Enter'); pg.wait_for_timeout(500)
        got=pg.evaluate("[...document.querySelectorAll('#panel-pilot [data-g=\"cell\"][data-t=\"loanlist\"]')].some(e=>e.textContent.includes('KEYTEST'))")
        ok('typed value saved', got)
        ok('focus is back on the same cell after saving', pg.evaluate("(()=>{const a=document.activeElement;return !!a&&a.matches&&a.matches('td[data-g=\"cell\"]')&&a.dataset.r=='%s'&&a.dataset.c=='%s'})()"%(rid,key)))
        pg.keyboard.press('ArrowDown'); ok('ArrowDown moves to the cell below', pg.evaluate("document.activeElement.matches('td[data-g=\"cell\"]')") )
        pg.keyboard.press('F2'); pg.wait_for_timeout(200); pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
        ok('Esc cancels and keeps focus on a cell', pg.evaluate("document.activeElement.matches('td[data-g=\"cell\"]')"))
    # --- Esc closes the 'how this was made' list
    pg.click('#panel-pilot [data-tab="overview"]'); pg.wait_for_timeout(400)
    pg.locator('#panel-pilot .pg-fig').first.click(); pg.wait_for_timeout(300)
    had=pg.locator('#pgDrill').count()==1
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    ok('Esc closes the records list', had and pg.locator('#pgDrill').count()==0)
  print('errors:',errs[:5]); print('FAILED:',bad)
finally:
  srv.terminate(); os.remove(ROOT+'/test/harness-b12.html')
