import subprocess, time
from playwright.sync_api import sync_playwright
h=open('/home/claude/fp/fleetpilot-update/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-main.js"></script>')
open('/home/claude/fp/fleetpilot-update/test/harness.html','w').write(h)
srv = subprocess.Popen(['python3','-m','http.server','8765','--directory','/home/claude/fp/fleetpilot-update'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1500,'height':900})
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror', lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('dialog', lambda d: d.accept('1234'))
    pg.add_init_script("""new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});""")
    pg.goto('http://localhost:8765/test/harness.html'); pg.wait_for_timeout(1500)
    # import first
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]', {'name':'x.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show', timeout=15000); pg.wait_for_timeout(800)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(1200)
    # vehicle with sub-hire + billing
    pg.click('.nav button[data-panel="vehicles"]')
    pg.fill('#v_reg','KZZ 001Z'); pg.fill('#v_make','Toyota'); pg.fill('#v_model','Probox'); pg.fill('#v_rate','5000')
    pg.select_option('#v_ownership','subhire'); pg.fill('#v_ownercost','3000'); pg.select_option('#v_billmode','auto')
    pg.click('#btnAddVehicle'); pg.wait_for_timeout(300)
    print('vehicle row:', pg.inner_text('#vehicleTable tbody tr:last-child')[:120].replace('\n',' ') if pg.locator('#vehicleTable tbody tr').count() else 'none')
    # coop client -> rental
    pg.click('.nav button[data-panel="clients"]'); pg.select_option('#c_typeFilter','coop')
    pg.click('#clientTable tbody tr:nth-child(1) .row-extract'); pg.wait_for_timeout(400)
    print('after extract: panel', pg.evaluate("document.body.dataset.panel"), '| type', pg.input_value('#r_type'), '| client', pg.eval_on_selector('#r_client','e=>e.options[e.selectedIndex].text'))
    # fill the form: same-day hire first
    pg.select_option('#r_vehicle', label=None, value=pg.eval_on_selector('#r_vehicle','e=>[...e.options].find(o=>o.text.includes("KZZ 001Z")).value'))
    pg.fill('#r_pickup','2026-10-01'); pg.fill('#r_pickuptime','09:00'); pg.fill('#r_return','2026-10-01'); pg.fill('#r_returntime','13:00')
    pg.wait_for_timeout(200); print('PREVIEW same day:', pg.inner_text('#r_preview'))
    pg.fill('#r_return','2026-10-05'); pg.fill('#r_returntime','10:00'); pg.wait_for_timeout(200); print('PREVIEW 1st-5th:', pg.inner_text('#r_preview'))
    print('sub-hire box visible:', pg.is_visible('#r_subwrap'))
    pg.select_option('#r_bill','days'); print('days box visible:', pg.is_visible('#r_days_wrap')); pg.fill('#r_days','3'); pg.wait_for_timeout(200); print('PREVIEW 3 days:', pg.inner_text('#r_preview'))
    pg.select_option('#r_bill','')
    pg.select_option('#r_status','Completed')
    pg.fill('#r_allowance','1500'); pg.fill('#r_fuel','2000')
    pg.select_option('#r_driver', index=1)
    pg.click('#btnAddRental'); pg.wait_for_timeout(500)
    pg.select_option('#r_typeFilter','coop')
    rows=pg.eval_on_selector_all('#rentalTable tbody tr','e=>e.map(x=>x.innerText.replace(/\\t/g," | ").replace(/\\n/g," "))')
    print('my rental row:', [r for r in rows if 'KZZ 001Z' in r][:1])
    # new client through the rental form (duplicate name must not double add)
    n0=pg.evaluate("document.querySelectorAll('#clientTable tbody tr').length")
    pg.select_option('#r_typeFilter','');
    pg.select_option('#r_status','Completed'); pg.select_option('#r_type','taxi'); pg.fill('#r_newclient','MARY TAXI TEST')
    pg.select_option('#r_vehicle', value=pg.eval_on_selector('#r_vehicle','e=>[...e.options].find(o=>o.text.includes("KZZ 001Z")).value'))
    pg.fill('#r_pickup','2026-10-10'); pg.fill('#r_return','2026-10-10'); pg.click('#btnAddRental'); pg.wait_for_timeout(300)
    pg.select_option('#r_status','Completed'); pg.select_option('#r_type','taxi'); pg.fill('#r_newclient','mary taxi test')
    pg.fill('#r_pickup','2026-10-12'); pg.fill('#r_return','2026-10-13'); pg.click('#btnAddRental'); pg.wait_for_timeout(300)
    pg.click('.nav button[data-panel="clients"]'); pg.select_option('#c_typeFilter','taxi')
    names=[t for t in pg.eval_on_selector_all('#clientTable tbody tr td:first-child','e=>e.map(x=>x.textContent)') if 'MARY' in t.upper()]
    print('MARY clients (must be 1):', names)
    # duplicate add from the clients form
    pg.select_option('#c_typeFilter','')
    pg.fill('#c_name','mary taxi test'); pg.click('#btnAddClient'); pg.wait_for_timeout(200); print('TOAST dup:', pg.inner_text('#toast'))
    # drivers panel
    pg.click('.nav button[data-panel="drivers"]'); pg.wait_for_timeout(200)
    print('weekly log gone:', pg.locator('#allowanceTable').count()==0, '| summary rows:', pg.inner_text('#allowanceSummaryTable tbody')[:160].replace('\n',' '))
    # performance
    pg.click('.nav button[data-panel="performance"]'); pg.wait_for_timeout(500)
    print('PERF heads:', pg.inner_text('#panel-performance thead')[:260].replace('\t',' | ').replace('\n',' '))
    pg.click('#panel-performance summary'); pg.check('#panel-performance [data-col="duration"]', force=True); pg.click('#panel-performance summary'); pg.check('#panel-performance [data-col="contract"]', force=True); pg.wait_for_timeout(200)
    print('after picker:', pg.inner_text('#panel-performance thead')[:300].replace('\t',' | ').replace('\n',' '))
    pg.select_option('#pf_type','coop'); pg.wait_for_timeout(200)
    print('coop totals:', pg.inner_text('#panel-performance tfoot')[:200].replace('\t',' | ').replace('\n',' '))
    pg.screenshot(path='/tmp/perf.png')
    b.close()
finally:
  srv.terminate()
print('console errors:', errs[:8])
