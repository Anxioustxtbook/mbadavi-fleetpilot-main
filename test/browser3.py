import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-main.js"></script>')
open(ROOT+'/test/harness.html','w').write(h)
srv = subprocess.Popen(['python3','-m','http.server','8766','--directory',ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1400,'height':1000})
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('dialog', lambda d: d.accept('1234'))
    pg.add_init_script("""new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});""")
    pg.goto('http://localhost:8766/test/harness.html'); pg.wait_for_timeout(1500)
    print('start failure:', pg.locator('#startfail').count())
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]', {'name':'PERFOMANCE_2026.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show', timeout=20000); pg.wait_for_timeout(1500)
    body=pg.inner_text('#impBody')
    print('review mentions fuel repeats:', 'Fuel line listed again as a positive figure' in body)
    # decide the 13 exact repeats through the real review screen: open that group and click "Remove this repeat" on the first
    grp=pg.locator('#impBody details', has_text='Fuel line listed again').first; grp.locator('summary').click()
    btn=grp.locator('button', has_text='Remove this repeat').first; print('remove buttons:', grp.locator('button', has_text='Remove this repeat').count())
    btn.click(); pg.wait_for_timeout(800)
    body=pg.inner_text('#impBody'); print('after one decision, remaining repeat lines text present:', 'Fuel line listed again' in body)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(1500)
    print('TOAST:', pg.inner_text('#toast')[:200])
    pg.click('.nav button[data-panel="pilot"]'); pg.wait_for_timeout(500)
    pg.click('#panel-pilot [data-tab="pages"]'); pg.wait_for_timeout(300)
    pg.click('#panel-pilot [data-pg="page"][data-page="fuel"]'); pg.wait_for_timeout(500)
    txt=pg.inner_text('#panel-pilot')
    for k in ['Balance with the station','Paid in (top-ups)','Fuel taken (fills)','Opening balance','Balance at month end','Fuel taken by car']:
        print(k, '->', k in txt)
    print('CARDS:', txt[txt.index('Balance with the station'):][:330].replace('\n',' | '))
    pg.screenshot(path='/tmp/fuel_page.png', full_page=True)
    # pick March and read the ledger
    pg.click('#panel-pilot [data-pg="fuelmonth"][data-month="2026-03"]'); pg.wait_for_timeout(300)
    t=pg.inner_text('#panel-pilot'); i=t.index('March 2026, line by line'); print('LEDGER:', t[i:i+300].replace('\n',' | '))
    n0=pg.locator('#panel-pilot .pg-fuelform').first.count()
    # add a top-up through the form
    form=pg.locator('#panel-pilot .pg-fuelform').first
    form.locator('[data-f="date"]').fill('2026-03-30'); form.locator('[data-f="amount"]').fill('7000'); form.locator('[data-f="note"]').fill('browser test')
    form.locator('[data-pg="topupsave"]').click(); pg.wait_for_timeout(600)
    t=pg.inner_text('#panel-pilot'); print('added row visible:', 'browser test' in t)
    # edit it
    pg.locator('tr', has_text='browser test').locator('[data-pg="topupedit"]').click(); pg.wait_for_timeout(300)
    form=pg.locator('#panel-pilot .pg-fuelform').first; print('edit value prefilled:', form.locator('[data-f="amount"]').input_value())
    form.locator('[data-f="amount"]').fill('9000'); form.locator('[data-pg="topupsave"]').click(); pg.wait_for_timeout(500)
    print('edited to 9,000:', '9,000' in pg.locator('tr', has_text='browser test').inner_text())
    # delete it
    pg.locator('tr', has_text='browser test').locator('[data-pg="topupdel"]').click(); pg.wait_for_timeout(500)
    print('deleted:', 'browser test' not in pg.inner_text('#panel-pilot'))
    # drill a top-up figure
    pg.locator('#panel-pilot [data-pg="drill"]').first.click(); pg.wait_for_timeout(300); print('drill opens:', pg.locator('#pgDrill').count())
    # repeats panel
    print('repeats panel shown:', 'entered twice' in pg.inner_text('#panel-pilot'))
    # idle default 7
    pg.click('#panel-pilot [data-tab="overview"]'); print('idle minutes field:', pg.input_value('#pl_idle'))
    # other pages still draw
    pg.click('#panel-pilot [data-tab="pages"]')
    for pid in ['progress','carwash','invoices','payments']:
        pg.click(f'#panel-pilot [data-pg="page"][data-page="{pid}"]'); pg.wait_for_timeout(150)
    print('other pages ok')
    b.close()
finally:
  srv.terminate()
print('console errors:', errs[:8])
