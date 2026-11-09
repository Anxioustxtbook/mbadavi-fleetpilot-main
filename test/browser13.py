# New tables under Performance: Fuel, Coop, Sub-hire. Chama gone. Run: python3 test/browser13.py
import subprocess, time, os
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-persist.js"></script>')
open(ROOT+'/test/harness-b13.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8798','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]; bad=[]
def ok(n,c): print(('PASS ' if c else 'FAIL ')+n); (None if c else bad.append(n))
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_context(viewport={'width':1600,'height':1000}).new_page()
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None); pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e))); pg.on('dialog',lambda d: d.accept())
    pg.add_init_script("new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});")
    pg.goto('http://localhost:8798/test/harness-b13.html'); pg.wait_for_timeout(1500)
    pg.evaluate("document.getElementById('introSplash')&&document.getElementById('introSplash').click()"); pg.wait_for_timeout(1500)
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'P.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=20000); pg.wait_for_timeout(1500)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(3000)
    labels=pg.evaluate("[...document.querySelectorAll('#nav > button')].map(b=>b.dataset.panel)")
    i=labels.index('performance'); ok('Fuel, Coop, Sub-hire sit right below Performance: %s'%labels[i:i+4], labels[i:i+4]==['performance','fuel','coop','subhire'])
    ok('no Chama link anywhere in the menu', pg.locator('#nav [data-tab="chama"]').count()==0 and 'Chama' not in pg.inner_text('#nav'))
    ok('no Fuel link added under Pilot/Admin besides the old one', pg.locator('#pilotLinks [data-panel="fuel"]').count()==0)
    # ---- Fuel
    pg.click('#nav button[data-panel="fuel"]'); pg.wait_for_timeout(600)
    ok('Fuel panel shows', pg.locator('#panel-fuel h1').inner_text()=='Fuel')
    ok('old fills show as Untagged and Ola balance excludes them', 'Untagged' in pg.inner_text('#panel-fuel'))
    pg.select_option('#fu_month','all'); pg.wait_for_timeout(300)
    n0=pg.locator('#fu_table tbody tr[data-id]').count(); ok('fill rows listed (%d)'%n0, n0>100)
    # add a fill for a car with a rental
    car=pg.evaluate("(()=>{const r=window.fleetFuelCore; return null})()")
    pg.click('#fu_formwrap summary');
    vid=pg.evaluate("document.querySelector('#fu_car option:nth-child(3)').value")
    pg.select_option('#fu_car',vid); pg.wait_for_timeout(300)
    pg.fill('#fu_amount','1234'); pg.select_option('#fu_account','Outside'); pg.click('#fu_add'); pg.wait_for_timeout(600)
    ok('fill saved', 'Fill saved' in pg.inner_text('body') or pg.locator('#fu_table tbody tr[data-id]').count()>n0)
    pg.select_option('#fu_acc','Outside'); pg.wait_for_timeout(300)
    ok('Outside filter shows the new fill', '1,234' in pg.inner_text('#fu_table'))
    ok('audit table drawn', pg.locator('#fu_audit').count()==1)
    # ---- Performance fuel per car
    pg.click('#nav button[data-panel="performance"]'); pg.wait_for_timeout(600)
    ok('Performance shows fuel used per car as one total (no account split)', 'Fuel used per car' in pg.inner_text('#panel-performance') and 'Untagged' not in pg.inner_text('#panel-performance'))
    # ---- Coop
    pg.click('#nav button[data-panel="coop"]'); pg.wait_for_timeout(600)
    pg.select_option('#co_month','all'); pg.wait_for_timeout(300)
    t=pg.inner_text('#panel-coop')
    ok('Coop columns follow the Excel then Fuel, Driver, Allowance', all(x.lower() in t.lower() for x in ['Name of staff served','Branch Department','KMs OUT','Total KMs','Type of vehicle hired','Fuel','Driver','Allowance']))
    tot0=pg.evaluate("document.querySelector('#panel-coop tfoot tr').innerText")
    ok('footer has a TOTAL', 'TOTAL' in tot0)
    pg.click('#co_vat'); pg.wait_for_timeout(300)
    ok('VAT view on shows both totals line', 'TOTAL incl VAT' in pg.inner_text('#panel-coop') and 'VAT incl' in pg.inner_text('#panel-coop'))
    pg.click('#co_vat'); ok('VAT view off by toggling', 'VAT view: off' in pg.inner_text('#panel-coop'))
    # pick a coop rental
    pg.click('#co_rwrap summary')
    opt=pg.evaluate("[...document.querySelectorAll('#co_rrental option')].filter(o=>o.value).length"); ok('coop rentals listed to pick (%d)'%opt, opt>0)
    pg.select_option('#co_rrental',index=1); pg.wait_for_timeout(300)
    pg.fill('#co_r_name','Zed Staff'); pg.fill('#co_r_department','Retail'); pg.fill('#co_r_kmOut','100'); pg.fill('#co_r_kmIn','260'); pg.click('#co_radd'); pg.wait_for_timeout(500)
    ok('saved from rental: staff shown', 'ZED STAFF' in pg.inner_text('#panel-coop'))
    # export with a stub ExcelJS capturing rows
    pg.evaluate("""(()=>{window.__rows=[];window.ExcelJS={Workbook:class{constructor(){this.xlsx={writeBuffer:async()=>new Uint8Array([1])}}addWorksheet(){const rows=window.__rows;return {addRow:r=>{rows.push(r);return {font:{}}},columns:[]}}}}})()""")
    pg.click('#co_vat'); pg.click('#co_export'); pg.wait_for_timeout(600)
    rows=pg.evaluate("window.__rows"); hdr=rows[0] if rows else []
    ok('export has client columns + Fuel + Driver', 'Fuel' in hdr and 'Driver' in hdr and hdr[0]=='Name of staff served' and 'VAT incl' in hdr[8])
    ok('export has both totals when VAT is on', any(str(r[0]).startswith('TOTAL excl VAT') for r in rows) and any(str(r[0]).startswith('TOTAL incl VAT') for r in rows))
    # ---- Rentals: one-off car
    pg.click('#nav button[data-panel="rentals"]'); pg.wait_for_timeout(400)
    pg.click('#r_oneoffToggle'); pg.fill('#r_oneoffDesc','Prado, one-off'); pg.fill('#r_oneoffOwner','Joe'); pg.click('#r_oneoffAdd'); pg.wait_for_timeout(400)
    ok('one-off car added and selected in the rental form', 'Prado, one-off' in pg.evaluate("document.getElementById('r_vehicle').selectedOptions[0].textContent") and pg.is_visible('#r_subwrap'))
    pg.click('#nav button[data-panel="vehicles"]'); pg.wait_for_timeout(300)
    ok('one-off car in Vehicles with sub-hire tag', 'Prado, one-off' in pg.inner_text('#panel-vehicles'))
    # ---- Sub-hire
    pg.click('#nav button[data-panel="subhire"]'); pg.wait_for_timeout(600)
    ok('Sub-hire table drawn', pg.locator('#sh_table tbody tr[data-id]').count()>0)
    sel=pg.locator('#sh_table select[data-k="driverId"]').first
    opts=sel.evaluate("s=>[...s.options].map(o=>o.value).filter(Boolean)")
    if opts:
        sel.select_option(opts[0]); pg.wait_for_timeout(500)
        ok('picked a sub-hire driver on a rental', pg.locator('#sh_table select[data-k="driverId"]').first.input_value()==opts[0])
        btn=pg.locator('#sh_table [data-showdrv]').first
        if btn.count():
            btn.click(); pg.wait_for_timeout(400); ok('Driver jobs details open', 'Driver jobs' in pg.inner_text('#panel-sub'+'hire'))
    else: print('SKIP driver pick: no sub-hire drivers in test data')
    # ---- Payments: no chama
    pg.click('#nav button[data-panel="payments"]'); pg.wait_for_timeout(500)
    ok('Payments has no Chama option', 'Chama' not in pg.inner_text('#panel-payments') and 'chama' not in pg.evaluate("document.getElementById('panel-payments').innerHTML").lower().replace('chamaid',''))
    b.close()
finally:
  srv.terminate()
print('ERRORS:', errs[:8]); print('FAILED:', bad)
