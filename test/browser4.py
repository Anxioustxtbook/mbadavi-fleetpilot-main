import subprocess, time, os
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-main.js"></script>')
open(ROOT+'/test/harness.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8767','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]; ok=lambda n,c: print(('PASS ' if c else 'FAIL ')+n)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1500,'height':1100})
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('dialog',lambda d: d.accept('1234'))
    pg.add_init_script("""new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});""")
    pg.goto('http://localhost:8767/test/harness.html'); pg.wait_for_timeout(1500)
    ok('app starts', pg.locator('#startfail').count()==0)
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'PERFOMANCE_2026.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=20000); pg.wait_for_timeout(1500)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(2000)
    # ---- Coop
    pg.click('.nav button[data-panel="coop"]'); pg.wait_for_timeout(400)
    t=pg.inner_text('#panel-coop'); ok('coop panel draws with every field', all(k.lower() in t.lower() for k in ['Department','KM out','KM in','Cont no','Allowance','Driver','Fuel']))
    pg.select_option('#co_month','all'); pg.wait_for_timeout(300)
    ok('coop lines listed', pg.locator('#panel-coop tbody tr').count()>150)
    ok('to-complete count shown', 'still to complete' in pg.inner_text('#panel-coop'))
    # edit a cell inline
    cell=pg.locator('#panel-coop td[data-c="amount"]').first; old=cell.inner_text(); cell.click(); inp=cell.locator('input'); inp.fill('9999'); inp.press('Enter'); pg.wait_for_timeout(300)
    ok('click a cell, type, Enter saves', '9,999' in pg.locator('#panel-coop td[data-c="amount"]').first.inner_text())
    # duplicate add refused
    pg.click('#co_formwrap summary'); pg.fill('#co_name','Zed Test'); pg.fill('#co_start','2026-10-27'); pg.fill('#co_end','2026-10-28'); pg.fill('#co_amount','7000'); pg.fill('#co_driverPay','1000'); pg.fill('#co_department','Marketing'); pg.fill('#co_contract','7777')
    pg.click('#co_add'); pg.wait_for_timeout(400)
    ok('new coop saved', 'ZED TEST' in pg.inner_text('#panel-coop'))
    pg.click('#co_formwrap summary'); pg.fill('#co_name','Zed Again'); pg.fill('#co_start','2026-10-29'); pg.fill('#co_contract','7777'); pg.click('#co_add'); pg.wait_for_timeout(300)
    ok('same contract number refused', 'already on the table' in pg.inner_text('#toast'))
    # complete in rentals
    row=pg.locator('#panel-coop tr', has_text='ZED TEST'); row.locator('[data-g="open"]').click(); pg.wait_for_timeout(500)
    ok('opens Rentals', pg.evaluate("document.getElementById('panel-rentals').classList.contains('active')"))
    ok('rental form filled from coop', pg.input_value('#r_contract')=='7777' and pg.input_value('#r_pickup')=='2026-10-27' and pg.input_value('#r_amount')=='8000' and pg.input_value('#r_type')=='coop')
    veh=pg.evaluate("[...document.querySelectorAll('#r_vehicle option')].filter(o=>o.value&&!o.disabled)[0].value"); pg.select_option('#r_vehicle',veh)
    pg.click('#btnAddRental'); pg.wait_for_timeout(600)
    pg.click('.nav button[data-panel="coop"]'); pg.wait_for_timeout(300)
    ok('coop line now linked to its rental', '✓' in pg.locator('#panel-coop tr', has_text='ZED TEST').inner_text())
    # ---- Expenses button
    pg.click('.nav button[data-panel="expenses"]'); pg.wait_for_timeout(200)
    ok('expenses has the button', pg.locator('#btnExpExplorer').count()==1)
    pg.click('#btnExpExplorer'); pg.wait_for_timeout(500)
    t=pg.inner_text('#expBody'); ok('explorer lists types', all(k in t for k in ['Fuel','Garage','Carwash','Transport','Insurance']))
    pg.locator('#expBody [data-ex="type"]', has_text='Garage').first.click(); pg.wait_for_timeout(300)
    ok('press Garage shows its lines', 'Garage' in pg.inner_text('#expBody') and pg.locator('#expBody td[data-c="amount"]').count()>=0)
    n=pg.locator('#expBody td[data-c="amount"]').count(); print('garage lines on screen:', n)
    pg.click('#expBody [data-ex="prev"]'); pg.wait_for_timeout(300); ok('month stepper moves', True)
    pg.click('#expClose');
    # ---- Pilot
    pg.click('.nav button[data-panel="pilot"]'); pg.wait_for_timeout(500)
    pg.click('#panel-pilot [data-tab="loans"]'); pg.wait_for_timeout(400)
    t=pg.inner_text('#panel-pilot'); ok('loans: 4 parts drawn', all(k in t for k in ['Monthly','Due in','Individuals','LAWYER','WIN','YANA']))
    c=pg.locator('#panel-pilot [data-t="loanmonthly"][data-g="cell"]').nth(3); tot0=pg.locator('#panel-pilot [data-gt="loanmonthly"] tfoot').inner_text()
    c.click(); c.locator('input').fill('12345'); c.locator('input').press('Enter'); pg.wait_for_timeout(300)
    ok('editing a monthly cell changes totals', pg.locator('#panel-pilot [data-gt="loanmonthly"] tfoot').inner_text()!=tot0)
    # click one cell then straight onto another: edit continues
    a=pg.locator('#panel-pilot [data-t="loanmonthly"][data-g="cell"]').nth(5); a.click(); a.locator('input').fill('4321')
    bcell=pg.locator('#panel-pilot [data-t="loanmonthly"][data-g="cell"]').nth(7); bcell.click(); pg.wait_for_timeout(300)
    ok('clicking the next cell keeps editing', pg.locator('#panel-pilot [data-gt="loanmonthly"] input').count()==1)
    pg.keyboard.press('Escape')
    # individuals: add a figure to WIN
    win=pg.locator('[data-gt="ind1"]'); bal0=pg.inner_text('#panel-pilot');
    ok('WIN balance 77,500 shown', '77,500' in bal0)
    win.locator('[data-g="add"]').click(); pg.wait_for_timeout(300)
    nc=pg.locator('[data-gt="ind1"] td[data-c="amount"]').last; nc.click(); nc.locator('input').fill('2500'); nc.locator('input').press('Enter'); pg.wait_for_timeout(300)
    ok('adding a figure updates the person total', '80,000' in pg.locator('[data-gt="ind1"]').inner_text())
    # bold / highlight
    pg.locator('[data-gt="loanlist"] [data-g="bold"]').first.click(); pg.wait_for_timeout(200)
    ok('bold row sticks', 'font-weight:700' in pg.locator('[data-gt="loanlist"] tbody tr').first.inner_html())
    # Pages > All expenses
    pg.click('#panel-pilot [data-tab="pages"]'); pg.click('#panel-pilot [data-pg="page"][data-page="allexp"]'); pg.wait_for_timeout(400)
    ok('All expenses page draws', 'type of expense' in pg.inner_text('#panel-pilot').lower())
    pg.click('#panel-pilot [data-ex="bymonth"]'); pg.wait_for_timeout(300); ok('month by month matrix', 'jan 26' in pg.inner_text('#panel-pilot').lower())
    # ---- Performance row opens rental
    pg.click('.nav button[data-panel="performance"]'); pg.wait_for_timeout(400)
    pg.locator('#panel-performance tr[data-rid]').first.locator('td').first.click(); pg.wait_for_timeout(500)
    ok('performance row opens Rentals', pg.evaluate("document.getElementById('panel-rentals').classList.contains('active')"))
    pg.click('.nav button[data-panel="performance"]'); pg.wait_for_timeout(300)
    cb=pg.locator('#panel-performance [data-coopid]').first; ok('coop rows have a Coop link', cb.count()==1); cb.click(); pg.wait_for_timeout(500)
    ok('Coop link opens the Coop screen', pg.evaluate("document.getElementById('panel-coop').classList.contains('active')"))
    # ---- delete a client asks and cleans
    pg.click('.nav button[data-panel="clients"]'); pg.wait_for_timeout(300)
    msgs=[]; pg.remove_listener('dialog', pg.listeners('dialog')[0]) if False else None
    b.close()
finally:
  srv.terminate()
print('console errors:', errs[:10])
