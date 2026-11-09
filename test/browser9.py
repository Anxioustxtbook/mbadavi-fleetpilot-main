import subprocess, time, os, json
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-save.js"></script>')
open(ROOT+'/test/harness-save.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8772','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
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
    pg.add_init_script("""delete window.showSaveFilePicker; Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true});
    new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});""")
    pg.goto('http://localhost:8772/test/harness-save.html'); pg.wait_for_timeout(1500)
    ok('app starts', pg.locator('#startfail').count()==0)
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'PERFOMANCE_2026.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=30000); pg.wait_for_timeout(1500)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(2500)
    def save(kind, month=None):
        pg.click('#btnFileMenu'); pg.click('#btnSave'); pg.wait_for_timeout(300)
        pg.select_option('#fmScope',kind)
        if month: pg.select_option('#fmScopeMonth',month)
        pg.evaluate("window.__wbs=[]")
        with pg.expect_download(timeout=20000) as d: pg.click('#btnSaveConfirm')
        name=d.value.suggested_filename; pg.wait_for_timeout(500); return name
    name=save('year'); print('  file:',name)
    ok('year file named', name=='Fleet Ledger - 2026.xlsx')
    info=pg.evaluate("""()=>{const wb=window.__wbs[window.__wbs.length-1]; const out={}; for(const n of ['Rentals','Expenses','Payments','Vehicles']){ const ws=wb.worksheets.find(w=>w.name===n); if(!ws){out[n]=null;continue;} out[n]={rows:ws.rows.length, bands:ws.rows.filter(r=>String(r.values[0]).startsWith('\\u25BC')).map(r=>r.values[0]), nested:ws.rows.filter(r=>r.outlineLevel===1).length, first:ws.rows.slice(0,3).map(r=>r.values.slice(0,4))}; } return out;}""")
    print(json.dumps(info)[:900])
    ok('Rentals grouped by month (band per month)', info['Rentals'] and len(info['Rentals']['bands'])>=9)
    ok('Expenses grouped by month', info['Expenses'] and len(info['Expenses']['bands'])>=9)
    ok('Rows folded under month heading (outline)', info['Rentals']['nested']>1000)
    ok('Vehicles not grouped', info['Vehicles'] and len(info['Vehicles']['bands'])==0)
    ok('no error toast on year save', 'Could not' not in pg.inner_text('#toast') and 'integrity' not in pg.inner_text('#toast').lower())
    print('  toast:', pg.inner_text('#toast')[:200])
    # previous month
    opts=pg.evaluate("""()=>{document.getElementById('btnFileMenu').click();document.getElementById('btnSave').click();return [...document.querySelectorAll('#fmScopeMonth option')].map(o=>o.value)}""")
    print('  months:',opts)
    pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
    name=save('previous', opts[0]); print('  file:',name)
    info=pg.evaluate("""()=>{const wb=window.__wbs[window.__wbs.length-1]; const ws=wb.worksheets.find(w=>w.name==='Rentals'); return {rows:ws.rows.length, bands:ws.rows.filter(r=>String(r.values[0]).startsWith('\\u25BC')).length, dates:[...new Set(ws.rows.slice(1).map(r=>String(r.values[6]).slice(0,7)))].slice(0,5)}}""")
    print(info)
    ok('previous month only has that month, with one month heading', info['bands']==1 and len(info['dates'])<=3)
    # current month
    name=save('current'); print('  file:',name)
    ok('current month file saved', name.startswith('Fleet Ledger - '))
    # full save still works and is not grouped
    pg.click('#btnFileMenu'); pg.click('#btnSave'); pg.wait_for_timeout(300); pg.select_option('#fmScope','all')
    pg.evaluate("window.__wbs=[]")
    with pg.expect_download(timeout=20000) as d: pg.click('#btnSaveConfirm')
    pg.wait_for_timeout(500)
    info=pg.evaluate("""()=>{const wb=window.__wbs[window.__wbs.length-1]; const ws=wb.worksheets.find(w=>w.name==='Rentals'); return {rows:ws.rows.length, bands:ws.rows.filter(r=>String(r.values[0]).startsWith('\\u25BC')).length}}""")
    ok('full save has month headings and keeps all rentals', info['bands']>=9 and info['rows']>1100)
    print('ERRORS:', [e for e in errs if 'favicon' not in e][:6])
finally:
    srv.terminate()
print('FAILS:', fails)
