import subprocess, time, os, sys, re as re_
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-main.js"></script>')
open(ROOT+'/test/harness.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8771','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]; fails=[]
def ok(n,c):
    print(('PASS ' if c else 'FAIL ')+n)
    if not c: fails.append(n)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1500,'height':900})
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('dialog',lambda d: d.accept('1234'))
    pg.add_init_script("""new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});""")
    pg.goto('http://localhost:8771/test/harness.html'); pg.wait_for_timeout(1500)
    ok('app starts', pg.locator('#startfail').count()==0)
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'PERFOMANCE_2026.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=30000); pg.wait_for_timeout(1500)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(2500)
    # ---- search + totals on top in Rentals
    pg.click('.nav button[data-panel="rentals"]'); pg.wait_for_timeout(800)
    ok('Rentals: totals on top', pg.locator('#panel-rentals .tt-tot').count()>0 and pg.locator('#panel-rentals .tt-tot').first.is_visible())
    print('  rentals totals:', pg.locator('#panel-rentals .tt-tot').first.inner_text()[:200].replace('\n',' | '))
    pg.click('.nav button[data-panel="vehicles"]'); pg.wait_for_timeout(500)
    ok('Back button appears after moving', pg.locator('#ttBack.show').count()==1)
    pg.click('#ttBack'); pg.wait_for_timeout(500)
    ok('Back goes to Rentals', pg.locator('#panel-rentals.active').count()==1)
    # search button on a table that has none (Drivers / Clients / Vehicles)
    pg.click('.nav button[data-panel="clients"]'); pg.wait_for_timeout(600)
    ok('Clients: Search button present', pg.locator('#panel-clients .tt-bar .tt-btn').count()>0)
    n0=pg.locator('#clientTable tbody tr:visible').count()
    pg.click('#panel-clients .tt-bar .tt-btn'); pg.fill('#panel-clients .tt-search','zzzzqq'); pg.wait_for_timeout(200)
    ok('search filters rows', pg.locator('#clientTable tbody tr:visible').count()<n0)
    pg.fill('#panel-clients .tt-search',''); pg.wait_for_timeout(200)
    ok('clearing search restores rows', pg.locator('#clientTable tbody tr:visible').count()==n0)
    # back to top
    pg.click('.nav button[data-panel="rentals"]'); pg.wait_for_timeout(600)
    pg.evaluate("document.querySelector('.main').scrollTop=3000"); pg.wait_for_timeout(400)
    ok('Back-to-top shows after long scroll', pg.locator('#ttTop.show').count()==1)
    pg.click('#ttTop'); pg.wait_for_timeout(2200)
    ok('Back-to-top scrolls to top', pg.evaluate("document.querySelector('.main').scrollTop")<5)
    # ---- Pilot
    pg.click('.nav button[data-panel="pilot"]'); pg.wait_for_timeout(600)
    # Insurance totals
    pg.click('#panel-pilot [data-tab="insurance"]'); pg.wait_for_timeout(300)
    t=pg.inner_text('#panel-pilot'); tl=t.lower(); ok('Insurance totals per vehicle and per month', 'per vehicle' in tl and 'per month' in tl and 'insurance total' in tl)
    # Sub-hire tab
    pg.screenshot(path='/home/claude/shot_ins.png')
    pg.click('#panel-pilot [data-tab="subhire"]'); pg.wait_for_timeout(500)
    pg.screenshot(path='/home/claude/shot_sub.png')
    t=pg.inner_text('#panel-pilot'); ok('Sub-hire tab: owners and drivers', 'Paid to owners' in t and 'Drivers on sub-hire cars' in t)
    ok('Sub-hire lines shown', pg.locator('#panel-pilot [data-g="cell"][data-c="status"]').count()>5)
    # Chama
    pg.click('#panel-pilot [data-tab="chama"]'); pg.wait_for_timeout(400)
    t=pg.inner_text('#panel-pilot'); tl=t.lower(); ok('Chama: grid with Due / Paid on / Amount', re_.search(r'r\d+ due',tl) and re_.search(r'r\d+ paid on',tl) and re_.search(r'r\d+ amount',tl))
    ok('Chama: rows per slot', pg.locator('#panel-pilot [data-gt^="chama:"]').first.locator('tbody tr').count()>=10)
    # edit a paid-on date (late)
    cell=pg.locator('#panel-pilot td[data-c^="p"]').first; old=cell.inner_text(); cell.click(); inp=cell.locator('input'); inp.fill('2026-12-30'); inp.press('Enter'); pg.wait_for_timeout(300)
    ok('Chama: typing a paid date saves it', '2026-12-30' in pg.inner_text('#panel-pilot'))
    pg.screenshot(path='/home/claude/shot_chama.png',full_page=False)
    print('  chama summary:', pg.locator('#panel-pilot .subtitle').nth(2).inner_text()[:200])
    # rename
    nm=pg.locator('#panel-pilot input[data-cm-name]').first; nm.fill('Family Chama'); nm.press('Tab'); pg.wait_for_timeout(300)
    ok('Chama: rename works', 'Family Chama' in pg.locator('#panel-pilot input[data-cm-name]').first.input_value())
    # new chama
    pg.click('#panel-pilot [data-cm="newopen"]'); pg.fill('#cm_n_name','Chama Test'); pg.fill('#cm_n_amount','1000'); pg.fill('#cm_n_slots','3'); pg.fill('#cm_n_first','2026-11-01'); pg.fill('#cm_n_every','7'); pg.click('#panel-pilot [data-cm="create"]'); pg.wait_for_timeout(400)
    names=[pg.locator('#panel-pilot input[data-cm-name]').nth(i).input_value() for i in range(pg.locator('#panel-pilot input[data-cm-name]').count())]
    ok('Chama: new chama added', 'Chama Test' in names)
    # pay all 3 slots -> next round starts by itself
    blk=pg.locator('#panel-pilot [data-gt="chama:Chama Test"]')
    for i,d in enumerate(['2026-11-01','2026-11-08','2026-11-15']):
        c=blk.locator('td[data-c="p1"]').nth(i); c.click(); x=c.locator('input'); x.fill(d); x.press('Enter'); pg.wait_for_timeout(250)
    pg.click('#panel-pilot [data-cm="view"][data-name="Chama Test"][data-v="all"]'); pg.wait_for_timeout(300)
    print('  chama test text:', pg.inner_text('#panel-pilot [data-gt="chama:Chama Test"]')[:300].replace('\n',' | ')); ok('Chama: next round starts when the round is paid', 'r2 due' in pg.inner_text('#panel-pilot [data-gt="chama:Chama Test"]').lower())
    # ---- Fuel navigator
    pg.click('#panel-pilot [data-tab="pages"]'); pg.wait_for_timeout(300)
    pg.click('#panel-pilot [data-pg="page"][data-page="fuel"]'); pg.wait_for_timeout(500)
    m0=pg.locator('#panel-pilot select[data-pg-set="month"]').input_value()
    pg.click('#panel-pilot [data-pg="fuelprev"]'); pg.wait_for_timeout(300)
    m1=pg.locator('#panel-pilot select[data-pg-set="month"]').input_value()
    ok('Fuel: previous month', m1<m0)
    ok('Fuel: month shown line by line', ' line by line' in pg.inner_text('#panel-pilot'))
    pg.click('#panel-pilot [data-pg="fuelall"]'); pg.wait_for_timeout(500)
    ok('Fuel: all months line by line', pg.locator('#panel-pilot tr.pg-band').count()>6)
    # Back from pilot pages
    pg.click('#ttBack'); pg.wait_for_timeout(400)
    print('  back label:', pg.inner_text('#ttBack') if pg.locator('#ttBack.show').count() else '(hidden)')
    # ---- Save scope UI
    pg.click('#btnFileMenu'); pg.click('#btnSave'); pg.wait_for_timeout(400)
    ok('Save: "What to save" section', pg.locator('#fmScope').is_visible())
    pg.select_option('#fmScope','year'); pg.wait_for_timeout(200)
    ok('Save: year picker shown', pg.locator('#fmScopeYear').is_visible() and pg.locator('#fmScopeYear option').count()>=1)
    pg.select_option('#fmScope','previous'); pg.wait_for_timeout(200)
    ok('Save: previous-month picker lists months', pg.locator('#fmScopeMonth option').count()>=1)
    print('ERRORS:', [e for e in errs if 'favicon' not in e][:8])
finally:
    srv.terminate()
print('FAILS:', fails)
