# v11: payments stable, fuel cards click-through + mixed, performance/overview fuel trace, per-car performance, import quick edit, delete copies. Run: python3 test/browser14.py
import subprocess, time, os
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-persist.js"></script>')
open(ROOT+'/test/harness-b14.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8794','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]; bad=[]
def ok(n,c): print(('PASS ' if c else 'FAIL ')+n); (None if c else bad.append(n))
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_context(viewport={'width':1600,'height':1000}).new_page()
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None); pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e))); pg.on('dialog',lambda d: d.accept())
    pg.add_init_script("new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true})")
    pg.goto('http://localhost:8794/test/harness-b14.html'); pg.wait_for_timeout(1500)
    pg.evaluate("document.getElementById('introSplash')&&document.getElementById('introSplash').click()"); pg.wait_for_timeout(1500)
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'P.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=20000); pg.wait_for_timeout(1500)
    # ---- import quick edit
    pg.click('#impBody details summary >> nth=2'); pg.wait_for_timeout(200)
    n=pg.locator('#impBody [data-edit]').count(); ok('Edit button on review lines (%d)'%n, n>0)
    first=pg.locator('#impBody [data-edit]:visible').first; first.click(); pg.wait_for_timeout(200)
    ok('edit fields open', pg.locator('#impBody [data-editbox] input[data-ef]').count()>=2)
    amt=pg.locator('#impBody [data-editbox] input[data-ef="amount"]').first
    before=pg.inner_text('#impBody h3')
    amt.fill('12345'); pg.click('#impBody [data-editsave]'); pg.wait_for_timeout(600)
    ok('edit saved, list redrawn', pg.locator('#impBody [data-editbox]').count()==0)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(3000)
    # ---- payments stable
    pg.click('#nav button[data-panel="payments"]'); pg.wait_for_timeout(500)
    c1=pg.locator('#ph_list .tt-tot').count(); pg.wait_for_timeout(1500); c2=pg.locator('#ph_list .tt-tot').count()
    t1=pg.evaluate("document.querySelector('#ph_list table').getBoundingClientRect().top"); pg.wait_for_timeout(800); t2=pg.evaluate("document.querySelector('#ph_list table').getBoundingClientRect().top")
    ok('payments table does not slide (strips %d->%d, top %s->%s)'%(c1,c2,t1,t2), c2<=1 and t1==t2)
    # ---- fuel cards
    pg.click('#nav button[data-panel="fuel"]'); pg.wait_for_timeout(500)
    pg.select_option('#fu_month','all'); pg.wait_for_timeout(300)
    # tag a few fills: set first two fills Ola/Outside via add form on a car with a rental
    vid=pg.evaluate("document.querySelector('#fu_car option:nth-child(3)').value")
    for acc,amt in (('Ola','1000'),('Outside','2000')):
        if not pg.evaluate("document.getElementById('fu_formwrap').open"): pg.click('#fu_formwrap summary')
        pg.select_option('#fu_car',vid); pg.wait_for_timeout(300)
        pg.fill('#fu_amount',amt); pg.select_option('#fu_account',acc); pg.click('#fu_add'); pg.wait_for_timeout(500)
    pg.select_option('#fu_month','all'); pg.wait_for_timeout(300)
    pg.click('[data-card="Outside"]'); pg.wait_for_timeout(700)
    ok('Outside card filters the table', pg.locator('#fu_acc').input_value()=='Outside')
    rows=pg.locator('#fu_table tbody tr[data-id]').count(); ok('Outside records shown (%d)'%rows, rows>=1)
    ok('table scrolled into view', pg.evaluate("(()=>{const r=document.getElementById('fu_table').getBoundingClientRect();return r.top<innerHeight})()"))
    pg.click('[data-card="Ola"]'); pg.wait_for_timeout(500); ok('Ola card filters', pg.locator('#fu_acc').input_value()=='Ola')
    # mixed: the car's rental got an Ola fill and an Outside fill only if same rental; check audit has Source col
    ok('audit has Source column', 'source' in pg.inner_text('#fu_audit thead').lower())
    pg.click('[data-card="Mixed"]'); pg.wait_for_timeout(500); ok('Mixed card sets rental filter', pg.locator('#fu_src').input_value()=='Mixed')
    # ---- performance trace
    pg.click('#nav button[data-panel="performance"]'); pg.wait_for_timeout(600)
    ok('Performance: per-car table', 'Performance by car' in pg.inner_text('#panel-performance'))
    ok('Performance: no Ola/Outside split column', 'Untagged' not in pg.inner_text('#panel-performance'))
    pg.click('#panel-performance [data-fuelgo] >> nth=1'); pg.wait_for_timeout(800)
    ok('fuel figure opens the Fuel panel', pg.evaluate("document.body.dataset.panel")=='fuel')
    # ---- overview
    pg.click('#nav button[data-panel="pilot"]'); pg.wait_for_timeout(500)
    ok('Overview: per-car table', 'Performance by car' in pg.inner_text('#panel-pilot'))
    pg.click('#panel-pilot table.pg-table [data-fuelgo] >> nth=0'); pg.wait_for_timeout(600)
    ok('Overview fuel total opens Fuel panel', pg.evaluate("document.body.dataset.panel")=='fuel')
    # ---- reports fuel
    pg.click('#nav button[data-panel="reports"]'); pg.wait_for_timeout(500)
    if pg.locator('#repCards [data-fuelgo]').count():
        pg.click('#repCards [data-fuelgo]'); pg.wait_for_timeout(500); ok('Report fuel opens Fuel panel', pg.evaluate("document.body.dataset.panel")=='fuel')
    # ---- delete copies
    pg.click('#btnFileMenu'); pg.click('#btnRecover'); pg.wait_for_timeout(800)
    ok('recover lists copies with size', 'on this device' in pg.inner_text('#rcBody'))
    n0=pg.locator('#rcBody [data-rcdel]').count()
    if n0:
        pg.click('#rcBody [data-rcdel] >> nth=0'); pg.wait_for_timeout(800); ok('a copy was deleted', pg.locator('#rcBody [data-rcdel]').count()==n0-1)
    ok('newest copy has no delete button', pg.locator('#rcBody [data-rc="latest"]').count()==1)
    # ---- clean database from the recover window, then bring the old work back
    cnt="DB=>0"
    before=pg.evaluate("document.querySelectorAll('#nav').length and (window.fleetFuelCore,1)")
    pg.click('#btnFileMenu'); pg.click('#btnRecover'); pg.wait_for_timeout(600)
    ok('clean option listed in the recover window', pg.locator('#rcBody [data-rcclean="all"]').count()==1)
    pg.click('#rcBody [data-rcclean="all"]'); pg.wait_for_timeout(1500)
    pg.click('#nav button[data-panel="rentals"]'); pg.wait_for_timeout(500)
    ok('rentals are empty after clean', pg.locator('#panel-rentals tbody tr[data-id], #rentalTable tbody tr:not(.empty-row)').count()==0)
    pg.click('#btnFileMenu'); pg.click('#btnRecover'); pg.wait_for_timeout(800)
    ok('earlier work still listed', pg.locator('#rcBody [data-rc]').count()>=1)
finally:
    srv.terminate()
print('ERRORS:',[e for e in errs if 'favicon' not in e][:5]); print('FAILED:',bad)
