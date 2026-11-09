import subprocess, time, sys
from playwright.sync_api import sync_playwright
h=open('/home/claude/fp/fleetpilot-update/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-main.js"></script>')
open('/home/claude/fp/fleetpilot-update/test/harness.html','w').write(h)
srv = subprocess.Popen(['python3','-m','http.server','8765','--directory','/home/claude/fp/fleetpilot-update'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1400,'height':900})
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('dialog', lambda d: d.accept('1234'))
    pg.add_init_script("""new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});""")
    pg.goto('http://localhost:8765/test/harness.html'); pg.wait_for_timeout(1500)
    print('start failure:', pg.locator('#startfail').count())
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]', {'name':'PERFOMANCE_2026.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show', timeout=15000); pg.wait_for_timeout(1500)
    txt=pg.inner_text('#impBody'); print('MODAL:', txt[:420].replace('\n',' | '))
    print('review groups', pg.locator('#impBody details').count())
    print('go disabled before tick:', pg.is_disabled('#impGo'))
    pg.check('#impOk'); print('go disabled after tick:', pg.is_disabled('#impGo'))
    pg.click('#impGo'); pg.wait_for_timeout(1500)
    print('TOAST:', pg.inner_text('#toast'))
    pg.click('.nav button[data-panel="rentals"]'); print('rental rows', pg.locator('#rentalTable tbody tr').count())
    print('first rental row:', pg.inner_text('#rentalTable tbody tr:nth-child(2)')[:160].replace('\n',' '))
    pg.click('.nav button[data-panel="clients"]'); print('client rows', pg.locator('#clientTable tbody tr').count())
    pg.select_option('#c_typeFilter','coop'); print('coop clients', pg.locator('#clientTable tbody tr').count(), pg.inner_text('#clientTable tbody tr:nth-child(1)')[:80].replace('\n',' '))
    pg.click('.nav button[data-panel="pilot"]'); pg.wait_for_timeout(500)
    print('pilot active:', pg.locator('#panel-pilot.active').count())
    print('OVERVIEW:', pg.inner_text('#panel-pilot')[:700].replace('\n',' | '))
    for t in ['loans','insurance','ochwada']:
        pg.click(f'#panel-pilot [data-tab="{t}"]'); print(t.upper(), pg.inner_text('#panel-pilot')[100:380].replace('\n',' | '))
    pg.screenshot(path='/tmp/pilot.png')
    b.close()
finally:
  srv.terminate()
print('console errors:', errs[:8])
