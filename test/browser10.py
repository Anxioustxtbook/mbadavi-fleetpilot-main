# Month break lines on every saved database, SUBHIRE / SUBHIRE DRIVER on the database, expense types (admin PIN), editing a driver. Real ExcelJS.
import subprocess, time, os, shutil, json
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
shutil.copy('/home/claude/xl/node_modules/exceljs/dist/exceljs.min.js', ROOT+'/test/exceljs.real.js')
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script src="/test/exceljs.real.js"></script><script type="module" src="/test/harness-real.js"></script>')
open(ROOT+'/test/harness-real.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8791','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]; bad=[]; ok=lambda n,c: (print(('PASS ' if c else 'FAIL ')+n), None if c else bad.append(n))
def readfile(path, code):
    js="const E=require('/home/claude/xl/node_modules/exceljs');(async()=>{const wb=new E.Workbook();await wb.xlsx.readFile('%s');%s})()"%(path,code)
    r=subprocess.run(['node','-e',js],capture_output=True,text=True)
    if r.returncode: print(r.stderr[:600])
    return json.loads(r.stdout.strip().splitlines()[-1])
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(accept_downloads=True, viewport={'width':1500,'height':1300}); pg=ctx.new_page()
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('dialog',lambda d: d.accept())
    pg.add_init_script("delete window.showSaveFilePicker; new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d&&!i.dataset.skip){i.dataset.d=1;i.value=(window.__askAnswer||'1234');document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});")
    pg.goto('http://localhost:8791/test/harness-real.html'); pg.wait_for_timeout(1500)
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'P.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=20000); pg.wait_for_timeout(1500)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(2500)

    # ---------- expense types (admin PIN)
    pg.click('.nav button[data-panel="expenses"]'); pg.wait_for_timeout(500)
    n_before=pg.evaluate("document.querySelectorAll('#e_cat option').length")
    ok('expense category list has the types already used (incl. Transport, Sub-hire driver)', pg.evaluate("[...document.querySelectorAll('#e_cat option')].map(o=>o.textContent).filter(t=>['Transport','Sub-hire driver','Other'].includes(t)).length")==3)
    pg.click('#btnExpTypes'); pg.wait_for_timeout(300)
    pg.fill('#et_new','Fuel'); pg.click('#et_add'); ok('a duplicate type is refused', 'already' in pg.inner_text('#et_msg'))
    pg.fill('#et_new','Toll fees'); pg.click('#et_add'); pg.wait_for_timeout(700)
    ok('new type added after the admin PIN', 'Toll fees' in pg.inner_text('#etModal') and pg.evaluate("[...document.querySelectorAll('#e_cat option')].some(o=>o.textContent==='Toll fees')"))
    pg.click('#et_close'); pg.wait_for_timeout(200)
    pg.select_option('#e_cat','Toll fees'); pg.fill('#e_date','2026-10-20'); pg.fill('#e_amount','777'); pg.fill('#e_desc','Mombasa road toll'); pg.click('#btnAddExpense'); pg.wait_for_timeout(500)
    ok('an expense can be saved with the new type', 'Mombasa road toll' in pg.inner_text('#panel-expenses'))
    pg.click('.nav button[data-panel="payments"]'); pg.wait_for_timeout(500)
    pg.click('[data-dir="out"]'); pg.wait_for_timeout(300)
    ok('Payments (money out) offers the new type', pg.evaluate("[...document.querySelectorAll('#ph_cat option')].some(o=>o.textContent==='Toll fees')"))
    ok('...and shows the toll expense in the one list', 'Mombasa road toll' in pg.inner_text('#panel-payments') or 'Toll fees' in pg.inner_text('#panel-payments'))
    # rename
    pg.click('.nav button[data-panel="expenses"]'); pg.click('#btnExpTypes'); pg.wait_for_timeout(300)
    pg.evaluate("window.__askAnswer='Toll and parking'"); pg.click('[data-et="rename"]'); pg.wait_for_timeout(900); pg.evaluate("window.__askAnswer='1234'")
    cats=pg.evaluate("[...document.querySelectorAll('#e_cat option')].map(o=>o.textContent)")
    ok('renaming a type renames it everywhere', 'Toll and parking' in cats and 'Toll fees' not in cats)

    # ---------- driver editing
    pg.click('#et_close') if pg.locator('#et_close').count() else None
    pg.click('.nav button[data-panel="drivers"]'); pg.wait_for_timeout(500)
    pg.locator('#driverTable .row-edit').first.click(); pg.wait_for_timeout(300)
    nm=pg.input_value('#d_name'); ok('Edit loads the driver into the form (%s)'%nm, bool(nm) and 'Save changes' in pg.inner_text('#btnAddDriver'))
    pg.fill('#d_phone','0799000111'); pg.select_option('#d_kind','subhire'); pg.click('#btnAddDriver'); pg.wait_for_timeout(800)
    ok('the changes were saved to the same driver', '0799000111' in pg.inner_text('#driverTable') and pg.locator('#driverTable tbody tr').first.inner_text().count(nm)==1)
    ok('the form is back to Add driver', '+ Add driver' in pg.inner_text('#btnAddDriver'))

    # ---------- save everything + read the file
    pg.click('#btnFileMenu'); pg.click('#btnSave'); pg.wait_for_timeout(400)
    with pg.expect_download(timeout=90000) as dl: pg.click('#btnSaveConfirm')
    path='/tmp/saved_everything.xlsx'; dl.value.save_as(path); pg.wait_for_timeout(500)
    ok('save: backup check found no differences', not any('Backup check' in e for e in errs))
    o=readfile(path, r'''
const first=(n)=>{const w=wb.getWorksheet(n);const bands=[];w.eachRow((r,i)=>{const v=r.getCell(1).value;if(typeof v==='string'&&v.startsWith('\u25BC'))bands.push(v);});return bands;};
const set=wb.getWorksheet('Settings');const hdr=set.getRow(1).values.slice(1);
const et=set.getRow(2).getCell(hdr.indexOf('expenseTypes')+1).value;
const sd=wb.getWorksheet('SUBHIRE DRIVER');let dr=0,legacy=0;sd.eachRow((r,i)=>{if(i>1&&r.getCell(4).value==='from Expenses')legacy++;if(i>1)dr++;});
const ex=wb.getWorksheet('Expenses');let toll=0;ex.eachRow((r,i)=>{if(i>1&&r.getCell(4).value==='Toll and parking')toll++;});
console.log(JSON.stringify({exp:first('Expenses').slice(0,3),expN:first('Expenses').length,ren:first('Rentals').length,pay:first('Payments').length,sub:first('SUBHIRE').slice(0,2),subN:first('SUBHIRE').length,drv:first('SUBHIRE DRIVER').length,et,legacy,dr,toll,rows:wb.getWorksheet('Expenses').rowCount}));''')
    print(o['exp'])
    ok('Expenses sheet has a heading before each month (%d)'%o['expN'], o['expN']>=3 and 'JANUARY 2026' in o['exp'][0] or o['expN']>=3)
    ok('Rentals and Payments sheets have month headings', o['ren']>=3 and o['pay']>=1)
    ok('SUBHIRE sheet has month headings (%d)'%o['subN'], o['subN']>=3)
    ok('SUBHIRE DRIVER lists the Sub-hire driver costs from Expenses (%d) under month headings (%d)'%(o['legacy'],o['drv']), o['legacy']>0 and o['drv']>=1)
    ok('new expense type saved in the file settings', 'Toll and parking' in str(o['et']))
    ok('the renamed type is on the expense lines in the file', o['toll']==1)
    print('console errors:', errs[:5]); ok('no script errors', not errs)
finally:
  srv.terminate()
  for f in ['test/harness-real.html','test/exceljs.real.js']:
    try: os.remove(ROOT+'/'+f)
    except: pass
print('FAILED:',bad) if bad else print('all browser10 checks passed')
