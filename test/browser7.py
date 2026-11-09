# Saved file: tab order / hidden tabs / hidden fields, new SUBHIRE / SUBHIRE DRIVER / LOAN sheets, real .xlsx round trip. Also add-loan form, new-format pop-up, invoice picker.
import subprocess, time, os, shutil, json
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
shutil.copy('/home/claude/xl/node_modules/exceljs/dist/exceljs.min.js', ROOT+'/test/exceljs.real.js')
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script src="/test/exceljs.real.js"></script><script type="module" src="/test/harness-real.js"></script>')
open(ROOT+'/test/harness-real.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8783','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]; bad=[]; ok=lambda n,c: (print(('PASS ' if c else 'FAIL ')+n), None if c else bad.append(n))
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(accept_downloads=True, viewport={'width':1500,'height':1300}); pg=ctx.new_page()
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('dialog',lambda d: d.accept('1234'))
    pg.add_init_script("delete window.showSaveFilePicker; new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});")
    pg.goto('http://localhost:8783/test/harness-real.html'); pg.wait_for_timeout(1500)
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'P.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=20000); pg.wait_for_timeout(1500)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(2500)
    # ---- file layout window
    pg.click('#btnFileMenu'); pg.click('#btnSave'); pg.wait_for_timeout(400)
    t=pg.inner_text('#fmTabs')
    ok('layout list has SUBHIRE, SUBHIRE DRIVER and LOAN', all(x in t for x in ['SUBHIRE','SUBHIRE DRIVER','LOAN']))
    ok('Individuals tab starts hidden (it is inside LOAN)', pg.locator('#fmTabs [data-lay="show"][data-n="Individuals"]').is_checked()==False)
    first=lambda: pg.locator('#fmTabs .fm-lname').first.inner_text()
    f0=first()
    for _ in range(30):
        if first()=='SUBHIRE DRIVER': break
        pg.locator('#fmTabs [data-lay="up"][data-n="SUBHIRE DRIVER"]').click(); pg.wait_for_timeout(80)
    ok('moving a tab up works', first()=='SUBHIRE DRIVER' and f0!='SUBHIRE DRIVER')
    pg.locator('#fmTabs [data-lay="show"][data-n="Totals"]').uncheck(); pg.wait_for_timeout(200)
    pg.locator('#fmTabs [data-lay="fields"][data-n="Vehicles"]').click(); pg.wait_for_timeout(200)
    pg.locator('#fmTabs [data-lay="col"][data-n="Vehicles"][data-k="ownerCost"]').uncheck(); pg.wait_for_timeout(200)
    ok('hiding a field is remembered in the list', pg.locator('#fmTabs [data-lay="col"][data-n="Vehicles"][data-k="ownerCost"]').is_checked()==False)
    with pg.expect_download(timeout=60000) as dl: pg.click('#btnSaveConfirm')
    path='/tmp/saved_layout.xlsx'; dl.value.save_as(path); pg.wait_for_timeout(500)
    ok('save: backup check found no differences', not any('Backup check' in e for e in errs))
    # ---- read the real file back
    js=r'''
const E=require('/home/claude/xl/node_modules/exceljs');(async()=>{const wb=new E.Workbook();await wb.xlsx.readFile('/tmp/saved_layout.xlsx');
const out={names:wb.worksheets.map(w=>w.name),states:Object.fromEntries(wb.worksheets.map(w=>[w.name,w.state])),
 veh:(()=>{const w=wb.getWorksheet('Vehicles');const h=[];w.getRow(1).eachCell({includeEmpty:true},(c,i)=>h.push([c.value,w.getColumn(i).hidden]));return h;})(),
 sub:wb.getWorksheet('SUBHIRE')?wb.getWorksheet('SUBHIRE').rowCount:0, drv:wb.getWorksheet('SUBHIRE DRIVER')?wb.getWorksheet('SUBHIRE DRIVER').rowCount:0,
 loan:(wb.getWorksheet('LOAN')?wb.getWorksheet('LOAN').getColumn(1).values.filter(Boolean).slice(0,80):[]),
 indRows:wb.getWorksheet('Individuals')?wb.getWorksheet('Individuals').rowCount:0, vehRows:wb.getWorksheet('Vehicles').rowCount};
console.log(JSON.stringify(out));})()'''
    r=subprocess.run(['node','-e',js],capture_output=True,text=True);
    if r.returncode: print(r.stderr[:500])
    o=json.loads(r.stdout.strip().splitlines()[-1])
    ok('file: SUBHIRE DRIVER is the first tab', o['names'][0]=='SUBHIRE DRIVER')
    ok('file: SUBHIRE, SUBHIRE DRIVER and LOAN sheets exist', all(n in o['names'] for n in ['SUBHIRE','SUBHIRE DRIVER','LOAN']))
    ok('file: SUBHIRE has data rows (%d) and DRIVER (%d)'%(o['sub'],o['drv']), o['sub']>5 and o['drv']>5)
    ok('file: Individuals tab hidden but its data is saved (%d rows)'%o['indRows'], o['states'].get('Individuals')=='hidden' and o['indRows']>10)
    ok("file: Totals tab hidden", o["states"].get("Totals")=="hidden")
    hv=dict(o['veh']); ok('file: Vehicles ownerCost column hidden, others shown', hv.get('ownerCost')==True and hv.get('reg') in (False,None))
    ok('file: LOAN sheet holds loans, months and individuals', all(any(x in str(v) for v in o['loan']) for x in ['LOANS','MONTHLY INSTALMENTS','INDIVIDUALS','LAWYER']))
    ok('file: tab states keep a visible tab', 'visible' in o['states'].values())
    # ---- add loan form
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    pg.click('.nav button[data-panel="pilot"]'); pg.wait_for_timeout(500); pg.click('#panel-pilot [data-tab="loans"]'); pg.wait_for_timeout(600)
    n0=pg.locator('#panel-pilot [data-gt="loanlist"] tbody tr').count()
    ok('Loans shows Add a loan and the contact-developer button', pg.locator('[data-ln="newloan"]').count()==1 and pg.locator('[data-ln="newformat"]').count()==1)
    pg.click('[data-ln="newloan"]'); pg.wait_for_timeout(300)
    pg.click('#nl_ok'); ok('add loan without a name is refused', 'name' in pg.inner_text('#nl_err').lower())
    pg.fill('#nl_name','TEST BANK'); pg.fill('#nl_item','KDA 001A'); pg.fill('#nl_borrowed','500000'); pg.fill('#nl_inst','25000'); pg.fill('#nl_first','2026-11'); pg.fill('#nl_months','6'); pg.fill('#nl_day','5'); pg.click('#nl_ok'); pg.wait_for_timeout(600)
    ok('new loan appears in the loan list', pg.locator('#panel-pilot [data-gt="loanlist"] tbody tr').count()==n0+1 and 'TEST BANK' in pg.inner_text('#panel-pilot'))
    ok('its 6 months are scheduled (150,000)', '150,000' in pg.inner_text('#panel-pilot [data-gt="loanlist"]'))
    pg.click('[data-ln="newloan"]'); pg.wait_for_timeout(300); pg.fill('#nl_name','TEST BANK'); pg.fill('#nl_item','KDA 001A'); pg.fill('#nl_inst','1'); pg.click('#nl_ok')
    ok('same loan twice is refused', 'already exists' in pg.inner_text('#nl_err'))
    pg.click('#nl_fmt'); pg.wait_for_timeout(300)
    ok('different-format pop-up opens and mentions the developer', pg.locator('#lnFmtText').count()==1 and 'developer' in pg.inner_text('#lnModal').lower())
    pg.click('#lnFmtClose'); pg.wait_for_timeout(200)
    ok('Individuals sits inside Loans', 'part of Loans' in pg.inner_text('#panel-pilot'))
    # ---- invoice picker on Rentals
    pg.click('.nav button[data-panel="rentals"]'); pg.wait_for_timeout(500)
    pg.click('#r_invoice'); pg.wait_for_timeout(200)
    nopt=pg.evaluate("document.querySelectorAll('#invList option').length"); ok('invoice box offers existing invoices (%d)'%nopt, nopt>50)
    inv=pg.evaluate("(()=>{const m={};document.querySelectorAll('#invList option').forEach(o=>{});return [...document.querySelectorAll('#invList option')].map(o=>o.label).find(l=>/[2-9]\\d* rental/.test(l)||/ [2-9] rental/.test(l))})()")
    val=pg.evaluate("[...document.querySelectorAll('#invList option')].find(o=>/ [2-9]\\d* rental\\(s\\)|^[2-9]\\d* rental/.test(o.label)||o.label.includes(' 2 rental')||o.label.includes('3 rental')) ?.value||''")
    if val:
        pg.fill('#r_invoice',val); pg.dispatch_event('#r_invoice','input'); pg.wait_for_timeout(200)
        ok('typing a shared invoice says other rentals already use it', 'other rental' in pg.inner_text('#r_invoice_hint'))
    pg.fill('#r_invoice','ZZ-NEW-1'); pg.dispatch_event('#r_invoice','input'); ok('a new number is called new', 'New invoice' in pg.inner_text('#r_invoice_hint'))
    print('console errors:', errs[:5]); ok('no script errors', not errs)
finally:
  srv.terminate()
  for f in ['test/harness-real.html','test/exceljs.real.js']:
    try: os.remove(ROOT+'/'+f)
    except: pass
print('FAILED:',bad) if bad else print('all browser7 checks passed')
